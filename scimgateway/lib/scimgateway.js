// =================================================================================
// File:    scimgateway.js
//
// Author:  Jarle Elshaug
//
// Purpose: Started by endpoint plugin
//          Listens and replies on incoming SCIM requests
//          Communicates with plugin using event callback
// =================================================================================

'use strict'

const http = require('http')
const jsonata = require('jsonata')
const https = require('https')
const Koa = require('koa')
const cors = require('koa-cors')
const Router = require('koa-router')
const bodyParser = require('koa-bodyparser')
const jwt = require('jsonwebtoken')
const passport = require('passport')
const OIDCBearerStrategy = require('passport-azure-ad').BearerStrategy
const dot = require('dot-object')
const nodemailer = require('nodemailer')
const fs = require('fs')
const path = require('path')
const callsite = require('callsite')
const utils = require('../lib/utils')
const countries = require('../lib/countries')
const { createChecker } = require('is-in-subnet')
const { createTerminus } = require('@godaddy/terminus')
require('events').EventEmitter.prototype._maxListeners = Infinity
const { fetchInterceptors } = require('./interceptors/functions')
const { fetchNotification } = require('./adapters/functions/notifications')
const { cache } = require('./adapters/functions/cache')
const { useListeners } = require('./listeners')
require('dotenv')

const { tracingConfig } = require("./tracing/config");


let span;
let requestSpan;

let caches = cache()


/**
 * @constructor
 */
const ScimGateway = function () {
  const startTime = utils.timestamp()
  const stack = callsite()
  const requester = stack[1].getFileName()
  const pluginName = path.basename(requester, '.js')
  const configDir = path.join(path.dirname(requester), '..', 'config')
  const configFile = path.join(`${configDir}`, `${pluginName}.json`) // config name prefix same as pluging name prefix
  let config = require(configFile).scimgateway
  let extConfigErr
  try {
    config = ScimGateway.prototype.processExtConfig(pluginName, config, true) // external config support process.env and process.file
  } catch (err) { extConfigErr = err }

  const gwName = path.basename(__filename, '.js') // prefix of current file
  const logDir = path.join(path.dirname(requester), '..', 'logs')
  const Log = require('../lib/logger').Log
  const log = new Log(utils.extendObj(utils.copyObj(config.log), { category: pluginName, colorize: process.stdout.isTTY || false, loglevel: { file: (!config.log.loglevel.file || config.log.loglevel.file === 'off') ? null : 'debug', console: 'debug' } }), path.join(`${logDir}`, `${pluginName}.log`))
  const logger = log.logger()
  this.logger = logger // exposed to plugin
  this.notValidAttributes = notValidAttributes // exposed to plugin
  this.authPassThroughAllowed = false // set to true by plugin if allowed
  let pwErrCount = 0
  let requestCounter = 0
  const oAuthTokenExpire = 3600 // seconds
  let isMailLock = false
  let ipAllowListChecker
  let scimDef
  let multiValueTypes
  let server

  let api;
let tracer
let verifyTracing = (ctx, name) => null
let endSpan = () => null
try{
  if(tracingConfig.enabled){
    api = require('@opentelemetry/api')
    const tracingFunctions = require('./tracing')
    verifyTracing = tracingFunctions.verifyTracing
    endSpan = tracingFunctions.endSpan
    
    const {setupTracing} = require('./tracing/tracer')
    tracer = setupTracing(`${tracingConfig.name} - ${pluginName.split('-').slice(1).join('-')}`);
    verifyTracing = (ctx, name) => tracingFunctions.verifyTracing(tracer, ctx, name)
  }
} catch(err){
  /* eslint-disable */console.log(...oo_oo(`182307278_97_2_97_42_4`,'error loading tracing API'))
}

  if (extConfigErr) {
    logger.error(`${gwName}[${pluginName}] ${extConfigErr.message}`)
    logger.error(`${gwName}[${pluginName}] stopping...\n`)
    throw (new Error('Using exception to stop further asynchronous code execution (ensure synchronous logger flush to logfile and exit program), please ignore this one...'))
  }

  if (!config.scim) config.scim = {}
  if (!config.log) config.log = {}
  if (!config.log.loglevel) config.log.loglevel = {}
  if (!config.auth) config.auth = {}
  if (!config.auth.basic) config.auth.basic = []
  if (!config.auth.bearerToken) config.auth.bearerToken = []
  if (!config.auth.bearerJwt) config.auth.bearerJwt = []
  if (!config.auth.bearerJwtAzure) config.auth.bearerJwtAzure = []
  if (!config.auth.bearerOAuth) config.auth.bearerOAuth = []
  if (!config.auth.passThrough) config.auth.passThrough = {}
  config.auth.oauthTokenStore = {} // oauth token store
  if (!config.certificate) config.certificate = {}
  if (!config.certificate.pfx) config.certificate.pfx = {}
  if (!config.emailOnError) config.emailOnError = {}
  if (!config.emailOnError.smtp) config.emailOnError.smtp = {}
  if (!config.kubernetes) config.kubernetes = {}

  if (config.ipAllowList && Array.isArray(config.ipAllowList) && config.ipAllowList.length > 0) {
    ipAllowListChecker = createChecker(config.ipAllowList)
  }

  const handler = {}
  handler.Users = handler.users = {
    description: 'User',
    getMethod: 'getUsers',
    modifyMethod: 'modifyUser',
    createMethod: 'createUser',
    deleteMethod: 'deleteUser'
  }
  handler.Groups = handler.groups = {
    description: 'Group',
    getMethod: 'getGroups',
    modifyMethod: 'modifyGroup',
    createMethod: 'createGroup',
    deleteMethod: 'deleteGroup'
  }
  handler.servicePlans = handler.serviceplans = { // plugin-azure using "CustomSCIM"
    description: 'ServicePlan',
    getMethod: 'getServicePlans',
    modifyMethod: 'modifyServicePlan',
    createMethod: 'createServicePlan',
    deleteMethod: 'deleteServicePlan'
  }
  handler.healthCheck = handler.healthCheck = { 
    description: 'healthCheck',
    getMethod: 'getHealthCheck',
    
  }

  let foundBasic = false
  let foundBearerToken = false
  let foundBearerJwtAzure = false
  let foundBearerJwt = false
  let foundBearerOAuth = false
  let foundPassThrough = false
  let pwPfxPassword

  if (Array.isArray(config.auth.basic)) {
    const arr = config.auth.basic
    for (let i = 0; i < arr.length; i++) {
      try {
        if (arr[i].password) arr[i].password = ScimGateway.prototype.getPassword(`scimgateway.auth.basic[${i}].password`, configFile)
      } catch (err) {
        logger.error(`${gwName}[${pluginName}] getPassword error: ${err.message}`)
        throw err // above logger.error included because this unhanledExcepton will be handled by winston and may fail with an other internal winston error e.g. related to memoryUsage collection logic when running in unikernel
      }
      if (arr[i].username && arr[i].password) foundBasic = true
    }
    if (!foundBasic) config.auth.basic = []
  }

  if (Array.isArray(config.auth.bearerToken)) {
    const arr = config.auth.bearerToken
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].token) {
        try {
          arr[i].token = ScimGateway.prototype.getPassword(`scimgateway.auth.bearerToken[${i}].token`, configFile)
        } catch (err) {
          logger.error(`${gwName}[${pluginName}] getPassword error: ${err.message}`)
          throw err
        }
        if (arr[i].token) foundBearerToken = true
      }
    }
    if (!foundBearerToken) config.auth.bearerToken = []
  }

  if (Array.isArray(config.auth.bearerJwtAzure)) {
    const issuers = []
    const arr = config.auth.bearerJwtAzure
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].tenantIdGUID) {
        issuers.push(`https://sts.windows.net/${arr[i].tenantIdGUID}/`)
      }
    }
    if (issuers.length > 0) {
      foundBearerJwtAzure = true
      const azureOptions = {
        validateIssuer: true,
        passReqToCallback: false,
        loggingLevel: null,
        // identityMetadata: `https://login.microsoftonline.com/${tenantIdGUID}/.well-known/openid-configuration`,
        identityMetadata: 'https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration',
        clientID: '00000014-0000-0000-c000-000000000000', // Well known appid: Microsoft.Azure.SyncFabric
        audience: [
          // Well known appid: Issued for accessing Windows Azure Active Directory Graph Webservice
          '00000002-0000-0000-c000-000000000000',
          // Appid used for SCIM provisioning for non-gallery applications. See changes introduced, in reverse cronological order:
          // - https://github.com/MicrosoftDocs/azure-docs/commit/f6997c0952d2ad4f33ce7f5339eeb83c21b51f1e
          // - https://github.com/MicrosoftDocs/azure-docs/commit/64525fea0675a73b2e6b8fe42fbd03ee568cadfc
          '8adf8e6e-67b2-4cf2-a259-e3dc5476c621'
        ],
        issuer: issuers // array => passport.authenticate supports more than one AAD tenant
      }

      passport.use(new OIDCBearerStrategy(azureOptions, (token, callback) => { // using named strategy = tenantIdGUID, passport.authenticate then using name
        callback(null, token.sub, token) // Azure SyncFabric don't send user info claims, returning claim token.sub as user
      }))
    } else {
      config.auth.bearerJwtAzure = []
    }
  }

  if (Array.isArray(config.auth.bearerJwt)) {
    const arr = config.auth.bearerJwt
    for (let i = 0; i < arr.length; i++) {
      try {
        if (arr[i].secret) arr[i].secret = ScimGateway.prototype.getPassword(`scimgateway.auth.bearerJwt[${i}].secret`, configFile)
      } catch (err) {
        logger.error(`${gwName}[${pluginName}] getPassword error: ${err.message}`)
        throw err
      }
      if ((arr[i].options && arr[i].options.issuer) && (arr[i].secret || arr[i].publicKey)) {
        foundBearerJwt = true
        if (arr[i].publicKey) { // create publicKeyContent
          try {
            arr[i].publicKeyContent = fs.readFileSync(`${configDir}/certs/${arr[i].publicKey}`)
          } catch (err) {
            arr.splice(i, 1) // delete
            foundBearerJwt = false
            err.message = `failed reading file defined in configuration auth.bearerJwt: ${err.message}`
            logger.error(err.message)
          }
        }
      } else arr.splice(i, 1) // delete
    }
    if (!foundBearerJwt) config.auth.bearerJwt = []
  }

  if (Array.isArray(config.auth.bearerOAuth)) {
    const arr = config.auth.bearerOAuth
    for (let i = 0; i < arr.length; i++) {
      try {
        if (arr[i].client_secret) arr[i].client_secret = ScimGateway.prototype.getPassword(`scimgateway.auth.bearerOAuth[${i}].client_secret`, configFile)
      } catch (err) {
        logger.error(`${gwName}[${pluginName}] getPassword error: ${err.message}`)
        throw err // above logger.error included because this unhanledExcepton will be handled by winston and may fail with an other internal winston error e.g. related to memoryUsage collection logic when running in unikernel
      }
      if (arr[i].client_secret && arr[i].client_id) foundBearerOAuth = true
    }
    if (!foundBearerOAuth) config.auth.bearerOAuth = []
  }

  if (config.auth.passThrough.enabled === true) foundPassThrough = true

  if (config.certificate.pfx.password) pwPfxPassword = ScimGateway.prototype.getPassword('scimgateway.certificate.pfx.password', configFile)
  if (config.emailOnError.smtp.password) config.emailOnError.smtp.password = ScimGateway.prototype.getPassword('scimgateway.emailOnError.smtp.password', configFile)

  if (!foundBasic && !foundBearerToken && !foundBearerJwtAzure && !foundBearerJwt && !foundBearerOAuth && !foundPassThrough) {
    logger.error(`${gwName}[${pluginName}] Scimgateway password decryption failed or no password defined, or no auth methods configured`)
    logger.error(`${gwName}[${pluginName}] stopping...\n`)
    throw (new Error('Using exception to stop further asynchronous code execution (ensure synchronous logger flush to logfile and exit program), please ignore this one...'))
  }

  try {
    if (!fs.existsSync(configDir + '/wsdls')) fs.mkdirSync(configDir + '/wsdls')
    if (!fs.existsSync(configDir + '/certs')) fs.mkdirSync(configDir + '/certs')
    if (!fs.existsSync(configDir + '/schemas')) fs.mkdirSync(configDir + '/schemas')
  } catch (err) {}

  let isScimv2 = false
  if (config.scim.version === '2.0' || config.scim.version === 2) {
    isScimv2 = true
    scimDef = require('../lib/scimdef-v2')
  } else scimDef = require('../lib/scimdef-v1')

  if (config.scim.customSchema) { // merge plugin custom schema extension into core schemas
    let custom
    try {
      custom = JSON.parse(fs.readFileSync(`${configDir}/schemas/${config.scim.customSchema}`, 'utf8'))
    } catch (err) {
      throw new Error(`failed reading file defined in configuration "scim.customSchema": ${err.message}`)
    }
    if (!Array.isArray(custom)) custom = [custom]
    const schemas = ['User', 'Group']
    let customMerged = false
    for (let i = 0; i < schemas.length; i++) {
      const schema = scimDef.Schemas.Resources.find(el => el.name === schemas[i])
      const customSchema = custom.find(el => el.name === schemas[i])
      if (schema && customSchema && Array.isArray(customSchema.attributes)) {
        const arr1 = schema.attributes // core:1.0/2.0 schema
        const arr2 = customSchema.attributes
        schema.attributes = arr2.filter(arr2Obj => { // only merge attributes (objects) having unique name into core schema
          if (!arr1.some(arr1Obj => arr1Obj.name === arr2Obj.name)) {
            customMerged = true
            if (!isScimv2) arr2Obj.schema = 'urn:scim:schemas:core:1.0'
            return arr2Obj
          }
          return undefined
        }).concat(arr1)
      }
    }
    if (!customMerged) {
      const err = [
        'No custom SCIM schema attributes have been merged. Make sure using correct format e.g. ',
        '[{"name": "User", "attributes" : [...]}]. ',
        'Also make sure attribute names in attributes array do not conflict with core:1.0/2.0 SCIM attribute names'
      ].join()
      throw new Error(err)
    }
  }

  this.testmodeusers = scimDef.TestmodeUsers.Resources // exposed and used by plugin-loki
  this.testmodegroups = scimDef.TestmodeGroups.Resources // exposed and used by plugin-loki

  // multiValueTypes array contains attributes that will be used by "type converted objects" logic
  // groups, roles, and members are excluded
  // default: ['emails','phoneNumbers','ims','photos','addresses','entitlements','x509Certificates']
  // configuration skipTypeConvert = true disables logic by empty multiValueTypes array
  if (config.scim.skipTypeConvert === true) multiValueTypes = []
  else {
    multiValueTypes = getMultivalueTypes('User', scimDef) // not icluding 'Group' => 'members' are excluded
    for (let i = 0; i < multiValueTypes.length; i++) {
      if (multiValueTypes[i] === 'groups' || multiValueTypes[i] === 'roles' || multiValueTypes[i] === 'members') {
        multiValueTypes.splice(i, 1) // delete
        i -= 1
      }
    }
  }

  const logResult = async (ctx, next) => {
    const started = Date.now()
    await next() // once all middleware below completes, this continues
    const ellapsed = (Date.now() - started) + 'ms' // ctx.set('X-ResponseTime', ellapsed)
    const res = {
      statusCode: ctx.response.status,
      statusMessage: ctx.response.message,
      body: ctx.response.body
    }
    let userName
    const [authType, authToken] = (ctx.request.header.authorization || '').split(' ') // [0] = 'Basic' or 'Bearer'
    if (authType === 'Basic') [userName] = (Buffer.from(authToken, 'base64').toString() || '').split(':')
    if (!userName && authType === 'Bearer') userName = 'token'
    if (ctx.request.url !== '/favicon.ico') {
      if (ctx.response.status < 200 || ctx.response.status > 299) {
        let isEndpointAccessDenied = false
        if (res.body?.detail) {
          if (res.body.detail.includes('\"statusCode\":401')) isEndpointAccessDenied= true // eslint-disable-line
        } else if (res.body?.Errors) {
          if (Array.isArray(res.body.Errors) && res.body.Errors[0].description && res.body.Errors[0].description.includes('\"statusCode\":401')) { // eslint-disable-line
            isEndpointAccessDenied = true
          }
        }
        if (isEndpointAccessDenied) { // don't reveal original SCIM error message details related to access denied (e.g. using Auth PassThrough)
          ctx.response.set('Content-Type', 'application/json; charset=utf-8')
          ctx.response.status = 401 // ctx.response.message becomes default 'Unauthorized'
          ctx.response.body = { error: 'Access denied' }
          res.statusCode = ctx.response.status
          res.statusMessage = ctx.response.message
          res.body = ctx.response.body
        }
        logger.error(`${gwName}[${pluginName}] ${ellapsed} ${ctx.request.ipcli} ${userName} ${ctx.request.method} ${ctx.request.href} Inbound = ${JSON.stringify(ctx.request.body)} Outbound = ${JSON.stringify(res)}${(config.log.loglevel.file === 'debug' && ctx.request.url !== '/ping') ? '\n' : ''}`)
      } else logger.info(`${gwName}[${pluginName}] ${ellapsed} ${ctx.request.ipcli} ${userName} ${ctx.request.method} ${ctx.request.href} Inbound = ${JSON.stringify(ctx.request.body)} Outbound = ${JSON.stringify(res)}${(config.log.loglevel.file === 'debug' && ctx.request.url !== '/ping') ? '\n' : ''}`)
      requestCounter += 1 // logged on exit (not win process termination)
    }
    if (ctx.response.body && typeof ctx.response.body === 'object' && ctx.response.status !== 401) ctx.set('Content-Type', 'application/scim+json; charset=utf-8')
  }

  // start auth methods - used by auth
  const basic = (baseEntity, method, authType, authToken, url) => {
    return new Promise((resolve, reject) => { // basic auth
      if (url === '/ping' || url.endsWith('/oauth/token') || url === '/_ah/start' || url === '/_ah/stop' || url === '/favicon.ico') resolve(true) // no auth
      if (authType !== 'Basic') resolve(false)
      if (!foundBasic) resolve(false)
      if (foundPassThrough && this.authPassThroughAllowed) resolve(false)
      const [userName, userPassword] = (Buffer.from(authToken, 'base64').toString() || '').split(':')
      if (!userName || !userPassword) {
        return reject(new Error(`authentication failed for user ${userName}`))
      }
      const arr = config.auth.basic
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].username === userName && arr[i].password === userPassword) { // authentication OK
          if (arr[i].baseEntities) {
            if (Array.isArray(arr[i].baseEntities) && arr[i].baseEntities.length > 0) {
              if (!baseEntity) return reject(new Error(`baseEntity=${baseEntity} not allowed for user ${arr[i].username} according to basic configuration baseEntitites=${arr[i].baseEntities}`))
              if (!arr[i].baseEntities.includes(baseEntity)) return reject(new Error(`baseEntity=${baseEntity} not allowed for user ${arr[i].username} according to basic configuration baseEntitites=${arr[i].baseEntities}`))
            }
          }
          if (arr[i].readOnly === true && method !== 'GET') return reject(new Error(`only allowing readOnly for user ${arr[i].username} according to basic configuration readOnly=true`))
          return resolve(true)
        }
      }
      reject(new Error(`authentication failed for user ${userName}`))
    })
  }

  const bearerToken = (baseEntity, method, authType, authToken) => {
    return new Promise((resolve, reject) => { // bearer token
      if (authType !== 'Bearer' || !authToken) resolve(false)
      if (!foundBearerToken) resolve(false)
      const arr = config.auth.bearerToken
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].token === authToken) { // authentication OK
          if (arr[i].baseEntities) {
            if (Array.isArray(arr[i].baseEntities) && arr[i].baseEntities.length > 0) {
              if (!baseEntity) return reject(new Error(`baseEntity=${baseEntity} not allowed for this bearerToken according to bearerToken configuration baseEntitites=${arr[i].baseEntities}`))
              if (!arr[i].baseEntities.includes(baseEntity)) return reject(new Error(`baseEntity=${baseEntity} not allowed for this bearerToken according to bearerToken configuration baseEntitites=${arr[i].baseEntities}`))
            }
          }
          if (arr[i].readOnly === true && method !== 'GET') return reject(new Error('only allowing readOnly for this bearerToken according to bearerToken configuration readOnly=true'))
          return resolve(true)
        }
      }
      reject(new Error('bearerToken authentication failed'))
    })
  }

  const bearerJwtAzure = (baseEntity, ctx, next, authType, authToken) => {
    return new Promise((resolve, reject) => {
      if (authType !== 'Bearer' || !foundBearerJwtAzure) resolve(false) // no azure bearer token
      const payload = jwt.decode(authToken)
      if (!payload) resolve(false)
      if (!payload.iss) resolve(false)
      if (payload.iss.indexOf('https://sts.windows.net') !== 0) resolve(false)
      passport.authenticate('oauth-bearer', { session: false }, (err, user, info) => {
        if (err) { return reject(err) }
        if (user) { // authenticated OK
          const arr = config.auth.bearerJwtAzure
          for (let i = 0; i < arr.length; i++) {
            if (arr[i].tenantIdGUID && payload.iss.includes(arr[i].tenantIdGUID)) {
              if (arr[i].baseEntities) {
                if (Array.isArray(arr[i].baseEntities) && arr[i].baseEntities.length > 0) {
                  if (!baseEntity) return reject(new Error(`baseEntity=${baseEntity} not allowed for user ${arr[i].tenantIdGUID} according to bearerJwtAzure configuration baseEntitites=${arr[i].baseEntities}`))
                  if (!arr[i].baseEntities.includes(baseEntity)) return reject(new Error(`baseEntity=${baseEntity} not allowed for user ${arr[i].tenantIdGUID} according to bearerJwtAzure configuration baseEntitites=${arr[i].baseEntities}`))
                }
              }
              if (arr[i].readOnly === true && ctx.request.method !== 'GET') return reject(new Error(`only allowing readOnly for user ${arr[i].tenantIdGUID} according to bearerJwtAzure configuration readOnly=true`))
            }
          }
          resolve(true)
        } else reject(new Error(`Azure JWT authorization failed: ${info}`))
      })(ctx, next)
    })
  }

  const jwtVerify = (baseEntity, method, el, authToken) => { // used by bearerJwt
    return new Promise((resolve, reject) => {
      jwt.verify(authToken, (el.secret) ? el.secret : el.publicKeyContent, el.options, (err, decoded) => {
        if (err) resolve(false)
        else {
          if (el.baseEntities) {
            if (Array.isArray(el.baseEntities) && el.baseEntities.length > 0) {
              if (!baseEntity) return resolve(false)
              if (!el.baseEntities.includes(baseEntity)) return resolve(false)
            }
          }
          if (el.readOnly === true && method !== 'GET') return resolve(false)
          resolve(true) // authorization OK
        }
      })
    })
  }

  const bearerJwt = async (baseEntity, method, authType, authToken) => {
    if (authType !== 'Bearer' || !foundBearerJwt) return false // no standard jwt bearer token
    const payload = jwt.decode(authToken)
    if (!payload) return false
    if (payload.iss && payload.iss.indexOf('https://sts.windows.net') === 0) return false // azure - handled by bearerJwtAzure
    const promises = []
    const arr = config.auth.bearerJwt
    for (let i = 0; i < arr.length; i++) {
      promises.push(jwtVerify(baseEntity, method, arr[i], authToken))
    }
    const arrResolve = await Promise.all(promises).catch((err) => { throw (err) })
    for (const i in arrResolve) {
      if (arrResolve[i]) return true
    }
    throw new Error('JWT authentication failed')
  }

  const bearerOAuth = (baseEntity, method, authType, authToken) => {
    return new Promise((resolve, reject) => { // bearer token
      if (authType !== 'Bearer' || !authToken) resolve(false)
      if (!foundBearerOAuth || !authToken) resolve(false)
      // config.auth.oauthTokenStore is autmatically generated by token create having syntax:
      // { config.auth.oauthTokenStore: <token>: { expireDate: <timestamp>, readOnly: <copy-from-config>, baseEntities: [ <copy-from-config> ], isTokenRequested: true }}
      const arr = config.auth.bearerOAuth
      if (config.auth.oauthTokenStore[authToken]) { // authentication OK
        const tokenObj = config.auth.oauthTokenStore[authToken]
        if (Date.now() > tokenObj.expireDate) {
          delete config.auth.oauthTokenStore[authToken]
          const err = new Error('OAuth access token expired')
          err.token_error = 'invalid_token'
          err.token_error_description = 'The access token expired'
          return reject(err)
        }
        if (tokenObj.baseEntities) {
          if (Array.isArray(tokenObj.baseEntities) && tokenObj.baseEntities.length > 0) {
            if (!baseEntity) return reject(new Error(`baseEntity=${baseEntity} not allowed for this bearerOAuth according to bearerOAuth configuration baseEntitites=${tokenObj.baseEntities}`))
            if (!tokenObj.baseEntities.includes(baseEntity)) return reject(new Error(`baseEntity=${baseEntity} not allowed for this bearerOAuth according to bearerOAuth configuration baseEntitites=${tokenObj.baseEntities}`))
          }
        }
        if (tokenObj.readOnly === true && method !== 'GET') return reject(new Error('only allowing readOnly for this bearerOAuth according to bearerOAuth configuration readOnly=true'))
        return resolve(true)
      } else {
        for (let i = 0; i < arr.length; i++) { // resolve if token memory store have been cleared because of a gateway restart
          if (utils.getEncrypted(authToken, arr[i].client_secret) === arr[i].client_secret && !arr[i].isTokenRequested) {
            arr[i].isTokenRequested = true // flagged as true to not allow repeated resolvements because token will also be cleared when expired
            const baseEntities = utils.copyObj(arr[i].baseEntities)
            let expires
            let readOnly = false
            if (arr[i].readOnly && arr[i].readOnly === true) readOnly = true
            if (arr[i].expires_in && !isNaN(arr[i].expires_in)) expires = arr[i].expires_in
            else expires = oAuthTokenExpire
            config.auth.oauthTokenStore[authToken] = {
              expireDate: Date.now() + expires * 1000,
              readOnly: readOnly,
              baseEntities: baseEntities
            }
            return resolve(true)
          }
        }
      }
      reject(new Error('OAuth authentication failed'))
    })
  }

  const authPassThrough = async (baseEntity, method, authType, authToken, ctx) => {
    if (!foundPassThrough || !this.authPassThroughAllowed) return false
    if (!authToken) return false
    if (authType === 'Basic') {
      const [userName, userPassword] = (Buffer.from(authToken, 'base64').toString() || '').split(':')
      if (!userName || !userPassword) return false
    }
    const obj = config.auth.passThrough
    if (obj.baseEntities) {
      if (Array.isArray(obj.baseEntities) && obj.baseEntities.length > 0) {
        if (!baseEntity || !obj.baseEntities.includes(baseEntity)) throw new Error(`baseEntity=${baseEntity} not allowed for passThrough according to passThrough configuration baseEntitites=${obj.baseEntities}`)
      }
    }
    if (obj.readOnly === true && method !== 'GET') throw new Error('only allowing readOnly for passThrough according to passThrough configuration readOnly=true')
    ctx.ctxCopy = {}
    ctx.ctxCopy.request = {}
    ctx.ctxCopy.request.header = Object.assign({}, ctx.request.header)
    return true
  }

  // end auth methods - used by auth

  const auth = async (ctx, next) => { // authentication/authorization
    const [authType, authToken] = (ctx.request.header.authorization || '').split(' ') // [0] = 'Basic' or 'Bearer'
    let baseEntity
    const arr = ctx.request.url.split('/')
    if (arr.length > 0) {
      const entity = arr[1].split('?')[0]
      if (!['Users', 'Groups', 'Schemas', 'ServiceProviderConfigs', 'scim'].includes(entity)) baseEntity = entity
    }
    try { // authenticate
      const arrResolve = await Promise.all([
        basic(baseEntity, ctx.request.method, authType, authToken, ctx.url),
        bearerToken(baseEntity, ctx.request.method, authType, authToken),
        bearerJwtAzure(baseEntity, ctx, next, authType, authToken),
        bearerJwt(baseEntity, ctx.request.method, authType, authToken),
        bearerOAuth(baseEntity, ctx.request.method, authType, authToken),
        authPassThrough(baseEntity, ctx.request.method, authType, authToken, ctx)])
        .catch((err) => { throw (err) })
      for (const i in arrResolve) {
        if (arrResolve[i]) return next() // auth OK - continue with routes
      }
      // all false - invalid auth method or missing pluging config
      let err
      if (authType.length < 1) err = new Error(`${ctx.url} request is missing authentication information`)
      else {
        err = new Error(`${ctx.url} request having unsupported authentication or plugin configuration is missing`)
        logger.debug(`${gwName}[${pluginName}] request authToken = ${authToken}`)
        logger.debug(`${gwName}[${pluginName}] request jwt.decode(authToken) = ${JSON.stringify(jwt.decode(authToken))}`)
      }
      if (authType === 'Bearer') ctx.set('WWW-Authenticate', 'Bearer realm=""')
      else if (foundBasic) ctx.set('WWW-Authenticate', 'Basic realm=""')
      ctx.set('Content-Type', 'application/json; charset=utf-8')
      ctx.status = 401
      ctx.body = { error: 'Access denied' }
      if (ctx.url !== '/favicon.ico') logger.error(`${gwName}[${pluginName}] ${err.message}`)
    } catch (err) {
      const body = {}
      if (authType === 'Bearer') {
        let str = 'realm=""'
        if (err.token_error) {
          str += `, error="${err.token_error}"`
          body.error = err.token_error
        }
        if (err.token_error_description) {
          str += `, error_description="${err.token_error_description}"`
          body.error_description = err.token_error_description
        }
        ctx.set('WWW-Authenticate', `Bearer ${str}`)
      } else ctx.set('WWW-Authenticate', 'Basic realm=""')
      ctx.set('Content-Type', 'application/json; charset=utf-8')
      ctx.status = 401
      if (Object.keys(body).length > 0) ctx.body = body
      else ctx.body = { error: 'Access denied' }
      if (pwErrCount < 3) {
        pwErrCount += 1
        logger.error(`${gwName}[${pluginName}] ${ctx.url} ${err.message}`)
      } else { // delay brute force attempts
        logger.error(`${gwName}[${pluginName}] ${ctx.url} ${err.message} => delaying response with 2 minutes to prevent brute force`)
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(ctx)
          }, 1000 * 60 * 2)
        })
      }
    }
  } // authentication

  const verifyContentType = (ctx, next) => {
    return new Promise((resolve) => {
      if (ctx.request.length) { // body is included - invalid content-type gives empty body (koa-bodyparser)
        const contentType = ctx.request.type.toLowerCase()
        if (contentType === 'application/json' || contentType === 'application/scim+json') return resolve(next())
        if (ctx.url.endsWith('/oauth/token')) return resolve(next())
        ctx.status = 415
        ctx.body = 'Content-Type header must be \'application/json\' or \'application/scim+json\''
        return resolve(ctx)
      }
      resolve(next())
    })
  }

  const ipAllowList = (ctx, next) => {
    return new Promise((resolve) => {
      ctx.request.ipcli = ctx.req.headers['x-forwarded-for'] || ctx.req.connection.remoteAddress
      ctx.request.ipcli = ctx.request.ipcli.split(',')[0] // used by logResult
      if (!ipAllowListChecker) return resolve(next())
      if (ipAllowListChecker(ctx.request.ipcli)) return resolve(next())
      logger.debug(`${gwName}[${pluginName}] client ip ${ctx.request.ipcli} not in ipAllowList`)
      ctx.status = 401
      ctx.body = 'Access denied'
      resolve(ctx)
    })
  }

  
  

  const app = new Koa()
  const router = new Router()

  useListeners(ScimGateway.prototype.endpointMapper, config.auth, require(configFile).endpoint.map)

app.use(cors({ origin: '*', credentials: true }));

  // Middleware run in the order they are defined and communicates through ctx
  // There is no return value, if there were it would be ignored
  app.use(logResult)
  app.use(bodyParser({ // parsed body store in ctx.request.body
    enableTypes: ['json', 'form'],
    extendTypes: { json: ['application/scim+json', 'text/plain'] },
    formTypes: { form: ['application/x-www-form-urlencoded'] },
    jsonLimit: (!config.payloadSize) ? undefined : config.payloadSize // default '1mb'
  }))

  // Start tracing (if enabled)
  app.use(async (ctx, next) => {
    return new Promise(async(resolve) => {
      span = verifyTracing(ctx, `${ctx.request.method} - ${ctx.request.path}`)
      resolve(next());
      })
  })

  // Middleware
  app.use(async (ctx, next) => {
    return new Promise(async(resolve) => {
    const { method } = ctx.request
      if(!['POST', 'PUT', 'PATCH'].includes(method)) {
        resolve(next());
        return;
      }

      async function runInterceptors(){
        let res = await fetchInterceptors(ctx, caches, verifyTracing)
        if(res){
          resolve(next());
        } else{
          resolve(ctx)
          endSpan(ctx, span, requestSpan)
        }
      }

      if(api && tracingConfig.enabled){
        TelemetryWrapper(api, async () => {
          runInterceptors()
        })
      } else{
        runInterceptors()
      }
      
    })
  })


  app.use(async (ctx, next) => {
    return new Promise(async(resolve) => {
    
      async function runAdapters(){        
        const notificationRes = await fetchNotification(ctx, 'before', caches, verifyTracing)
        if(notificationRes){
          resolve(next());  
        } else{
          resolve(ctx)
          endSpan(ctx, span, requestSpan)
        }
      }

      if(api && tracingConfig.enabled){
        TelemetryWrapper(api, async () => {
          runAdapters()
        })
      } else{
        runAdapters()
      }
    })
  })
  
  


  app.use(ipAllowList)
  app.use(auth) // authentication before routes
  app.use(verifyContentType)
  app.use(router.routes())
  app.use(router.allowedMethods())


  app.on('error', (err, ctx) => { // catching none try/catch in app middleware, also bodyparser and body not json
    logger.error(`${gwName}[${pluginName}] Koa method: ${ctx.method} url: ${ctx.origin + ctx.path} body: ${JSON.stringify(ctx.request.body)} error: ${err.message}`)
  })

  router.get('/ping', async (ctx) => { // auth not required
    const tx = 'hello'

    ctx.set('Content-Type', 'text/plain; charset=utf-8')
    ctx.body = tx
  })

  // Google App Engine B-class instance start/stop request
  router.get(['/_ah/start', '/_ah/stop'], async (ctx) => {
    const cli = ctx.request.ipcli
    const ver = process.env.GAE_VERSION
    if (!cli || cli !== '0.1.0.3' || !ver || !ctx.origin.includes(`.${ver}.`)) { // ctx.origin = http://<instance>.<version>.<project-id>.<region>.r.appspot.com
      ctx.status = 403 // request not coming from GCP App Engine
      return
    }
    // could have some start/stop logic here
    ctx.status = 200
  })

  // Initial connection, step #1: GET /ServiceProviderConfigs
  // If not included => Provisioning will always use GET /Users without any paramenters
  // scimv1 = ServiceProviderConfigs, scimv2 ServiceProviderConfig
  router.get(['/(|scim/)(ServiceProviderConfigs|ServiceProviderConfig)',
    '/:baseEntity/(|scim/)(ServiceProviderConfigs|ServiceProviderConfig)'], async (ctx) => {
    const tx = scimDef.ServiceProviderConfigs
    const location = ctx.origin + ctx.path
    if (tx.meta) tx.meta.location = location
    else {
      tx.meta = {"resourceType": "ServiceProviderConfig"}
      tx.meta.location = location
    }
    ctx.body = tx
    logger.debug(`${gwName}[${pluginName}] GET ${ctx.originalUrl} Response = ${JSON.stringify(tx)}`)
  })

  // Initial connection, step #2: GET /Schemas
  router.get(['/(|scim/)Schemas', '/:baseEntity/(|scim/)Schemas'], async (ctx) => {
    let tx = scimDef.Schemas
    tx = addResources(tx)
    tx = addSchemas(tx, null, isScimv2)
    ctx.body = tx
  })

  // oauth token request
  router.post(['/(|scim/)oauth/token', '/:baseEntity/(|scim/)oauth/token'], async (ctx) => {
    logger.debug(`${gwName}[${pluginName}] [oauth] token request`)
    if (!foundBearerOAuth) {
      logger.error(`${gwName}[${pluginName}] [oauth] token request, but plugin is missing config.auth.bearerOAuth configuration`)
      ctx.status = 500
      return
    }

    const jsonBody = ctx.request.body
    const [authType, authToken] = (ctx.request.header.authorization || '').split(' ') // [0] = 'Basic'
    if (authType === 'Basic') { // id and secret may be in authorization header if not already included in body
      const [id, secret] = (Buffer.from(authToken, 'base64').toString() || '').split(':')
      if (jsonBody.grant_type && id && secret) {
        if (jsonBody.grant_type === 'client_credentials' || jsonBody.grant_type === 'refresh_token') { // don't use refresh_token but allowing as type
          jsonBody.client_id = id
          jsonBody.client_secret = secret
        }
      }
    }

    let expires
    let token
    let readOnly = false
    let baseEntities
    let err
    let errDescr
    if (!jsonBody.grant_type || (jsonBody.grant_type !== 'client_credentials' && jsonBody.grant_type !== 'refresh_token')) {
      err = 'invalid_request'
      errDescr = 'request type must be Client Credentials (grant_type=client_credentials)'
    }

    if (!err) {
      const arr = config.auth.bearerOAuth
      for (let i = 0; i < arr.length; i++) {
        if (!arr[i].client_id || !arr[i].client_secret) continue
        if (arr[i].client_id === jsonBody.client_id && arr[i].client_secret === jsonBody.client_secret) { // authentication OK
          token = utils.getEncrypted(jsonBody.client_secret, jsonBody.client_secret)
          baseEntities = utils.copyObj(arr[i].baseEntities)
          if (arr[i].readOnly && arr[i].readOnly === true) readOnly = true
          if (arr[i].expires_in && !isNaN(arr[i].expires_in)) expires = arr[i].expires_in
          else expires = oAuthTokenExpire
          arr[i].isTokenRequested = true
          break
        }
      }
      if (!token) {
        err = 'invalid_client'
        errDescr = 'incorrect or missing client_id/client_secret'
        if (pwErrCount < 3) {
          pwErrCount += 1
        } else { // delay brute force attempts
          logger.error(`${gwName}[${pluginName}] [oauth] ${ctx.url} ${errDescr} => delaying response with 2 minutes to prevent brute force`)
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(ctx)
            }, 1000 * 60 * 2)
          })
        }
      }
    }

    if (err) {
      logger.error(`${gwName}[${pluginName}] [oauth] token request client_id: ${jsonBody ? jsonBody.client_id : ''} error: ${errDescr}`)
      ctx.status = 400
      ctx.body = {
        error: err,
        error_description: errDescr
      }
      return
    }

    const dtNow = Date.now()
    for (const i in config.auth.oauthTokenStore) { // cleanup any expired tokens
      const tokenObj = config.auth.oauthTokenStore[i]
      if (dtNow > tokenObj.expireDate) {
        delete config.auth.oauthTokenStore[i]
      }
    }

    config.auth.oauthTokenStore[token] = { // update token store
      expireDate: dtNow + expires * 1000, // 1 hour
      readOnly: readOnly,
      baseEntities: baseEntities
    }

    const tx = {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expires,
      refresh_token: token // ignored by scimgateway, but maybe used by client
    }

    ctx.set('Cache-Control', 'no-store')
    ctx.body = tx
  })

  router.get(['/(|scim/)Schemas/:id', '/:baseEntity/(|scim/)Schemas/:id'], async (ctx) => { // e.g /Schemas/Users | Groups | ServiceProviderConfigs
    let schemaName = ctx.params.id
    if (schemaName.substr(schemaName.length - 1) === 's') schemaName = schemaName.substr(0, schemaName.length - 1)
    const tx = scimDef.Schemas.Resources.find(el => el.name === schemaName)
    if (!tx) {
      ctx.status = 404
      let err = new Error(`Schema '${schemaName}' not found`)
      err = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = err
    } else {
      ctx.body = tx
    }
  })

  router.get(['/(|scim/)(ResourceTypes|ResourceType)',
    '/:baseEntity/(|scim/)(ResourceTypes|ResourceType)'], async (ctx) => { // ResourceTypes according to v2 specification
    const tx = scimDef.ResourceType
    ctx.body = tx
  })

  // ==========================================
  //           getUser (unique)
  //           getGroup (unique)
  // ==========================================
  router.get([`/(|scim/)(!${undefined}|Users|Groups|servicePlans)/:id`,
  `/:baseEntity/(|scim/)(!${undefined}|Users|Groups|servicePlans)/:id`], async (ctx) => {

    return await TelemetryWrapper(api, async () => {
      requestSpan = verifyTracing(ctx,  'Request')

    if (ctx.query.attributes) ctx.query.attributes = ctx.query.attributes.split(',').map(item => item.trim()).join()
    if (ctx.query.excludedAttributes) ctx.query.excludedAttributes = ctx.query.excludedAttributes.split(',').map(item => item.trim()).join()
    let u = ctx.originalUrl.substr(0, ctx.originalUrl.lastIndexOf('/'))
    u = u.substr(u.lastIndexOf('/') + 1) // u = Users, Groups
    const handle = handler[u]
    const id = decodeURIComponent(require('path').basename(ctx.params.id, '.json')) // supports <id>.json

    const getObj = {
      attribute: 'id',
      operator: 'eq',
      value: id
    }

    logger.debug(`${gwName}[${pluginName}] [Get ${handle.description}s] ${getObj.attribute}=${getObj.value}`)
    logger.debug(`${gwName}[${pluginName}] calling "${handle.getMethod}" and awaiting result`)

    try {
      const res = await this[handle.getMethod](ctx.params.baseEntity, utils.copyObj(getObj), ctx.query.attributes ? ctx.query.attributes.split(',').map(item => item.trim()) : [], ctx.ctxCopy)

      let scimdata = {
        Resources: [],
        totalResults: null
      }
      if (res) {
        if (res.Resources && Array.isArray(res.Resources)) {
          scimdata.Resources = res.Resources
          scimdata.totalResults = res.totalResults
        } else if (Array.isArray(res)) scimdata.Resources = res
        else if (typeof (res) === 'object' && Object.keys(res).length > 0) scimdata.Resources[0] = res
      }

      if (scimdata.Resources.length !== 1) {
        ctx.status = 404
        let err = new Error(`${handle.description} ${getObj.value} not found`)
        err = jsonErr(config.scim.version, pluginName, ctx.status, err)
        ctx.body = err
        endSpan(ctx, span, requestSpan)
        return
      }

      // check for user attribute groups and include if needed
      let userObj = scimdata.Resources[0]
      if (handle.getMethod === handler.users.getMethod && Object.keys(userObj).length > 0 && !userObj.groups && !config.scim.groupMemberOfUser) { // groupMemberOfUser can be set to true for skipping
        let arrAttr = []
        if (ctx.query.attributes) arrAttr = ctx.query.attributes.split(',')
        if ((!ctx.query.attributes || arrAttr.includes('groups')) && typeof this[handler.groups.getMethod] === 'function') { // include groups
          logger.debug(`${gwName}[${pluginName}] calling "${handler.groups.getMethod}" and awaiting result - groups to be included`)
          let res
          try {
            res = await this[handler.groups.getMethod](ctx.params.baseEntity, { attribute: 'members.value', operator: 'eq', value: getObj.value }, ['id', 'displayName'], ctx.ctxCopy)
          } catch (err) {} // method may be implemented but throwing error like groups not supported/implemented
          if (res && res.Resources && Array.isArray(res.Resources) && res.Resources.length > 0) {
            userObj.groups = []
            for (let i = 0; i < res.Resources.length; i++) {
              if (!res.Resources[i].id) continue
              const el = {}
              el.value = res.Resources[i].id
              if (res.Resources[i].displayName) el.display = res.Resources[i].displayName
              if (isScimv2) el.type = 'direct'
              else el.type = { value: 'direct' }
              userObj.groups.push(el) // { "value": "Admins", "display": "Admins", "type": "direct"}
            }
          }
        }
      }
      const location = ctx.origin + ctx.path
      userObj = addPrimaryAttrs(userObj)
      scimdata = utils.stripObj(userObj, ctx.query.attributes, ctx.query.excludedAttributes)
      scimdata = addSchemas(scimdata, handle.description, isScimv2)
      if (scimdata.meta) scimdata.meta.location = location
      else {
        scimdata.meta = {}
        scimdata.meta.location = location
      }
      ctx.body = scimdata
      await fetchNotification(ctx, 'onSuccess', caches, verifyTracing)
    } catch (err) {
      let scimType = errorStatus(err, isScimv2, ctx)
      const e = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = e
      await fetchNotification(ctx, 'onError', caches, verifyTracing)
    }
    
    endSpan(ctx, span, requestSpan)
    })
  })

  // ==========================================
  //           getUsers
  //           getGroups
  // ==========================================
  router.get(['/(|scim/)(Users|Groups|servicePlans)',
    '/:baseEntity/(|scim/)(Users|Groups|servicePlans)'], async (ctx) => {
      return await TelemetryWrapper(api, async () => {
        requestSpan = verifyTracing(ctx,  'Request')
      
    if (ctx.query.attributes) ctx.query.attributes = ctx.query.attributes.split(',').map(item => item.trim()).join()
    if (ctx.query.excludedAttributes) ctx.query.excludedAttributes = ctx.query.excludedAttributes.split(',').map(item => item.trim()).join()
    if(ctx.originalUrl.at(-1) === '/'){
      ctx.originalUrl = ctx.originalUrl.slice(0, ctx.originalUrl.length-1)
    }
    let u = ctx.originalUrl.substr(ctx.originalUrl.lastIndexOf('/') + 1) // u = Users, Groups, servicePlans, ...
    
    const ui = u.indexOf('?')
    if (ui > 0) u = u.substr(0, ui)
    const handle = handler[u]

    const getObj = {
      attribute: undefined,
      operator: undefined,
      value: undefined,
      rawFilter: ctx.query.filter, // included for advanced filtering
      startIndex: undefined,
      count: undefined
    }

    if (ctx.query.filter) {
      ctx.query.filter = ctx.query.filter.trim()
      const arrFilter = ctx.query.filter.split(' ')
      if (arrFilter.length === 3 || (arrFilter.length > 2 && arrFilter[2].startsWith('"') && arrFilter[arrFilter.length - 1].endsWith('"'))) {
        getObj.attribute = arrFilter[0] // userName
        getObj.operator = arrFilter[1].toLowerCase() // eq
        getObj.value = decodeURIComponent(arrFilter.slice(2).join(' ').replace(/"/g, '')) // bjensen
      }
    }

    let err
    if (getObj.attribute) {
      if (multiValueTypes.includes(getObj.attribute) || getObj.attribute === 'roles') {
        getObj.attribute = `${getObj.attribute}.value` // emails => emails.value
      } else if (getObj.attribute.includes('[')) { // e.g. rawFilter = emails[type eq "work"]
        const rePattern = /^(.*)\[(.*) (.*) (.*)\]$/
        const arrMatches = ctx.query.filter.match(rePattern)
        if (Array.isArray(arrMatches) && arrMatches.length === 5) {
          getObj.attribute = `${arrMatches[1]}.${arrMatches[2]}` // emails.type
          getObj.operator = arrMatches[3]
          getObj.value = arrMatches[4].replace(/"/g, '')
        } else {
          getObj.attribute = undefined
          getObj.operator = undefined
          getObj.value = undefined
        }
      }
      if (getObj.attribute === 'password') {
        err = new Error(`Not accepting password filtering: ${getObj.rawFilter}`)
        err.name = 'invalidFilter'
      }
    } else if (getObj.rawFilter && ![' and ', ' or ', ' not '].some(el => getObj.rawFilter.includes(el))) { // advanced filtering
      // err = new Error(`Invalid filter: ${getObj.rawFilter}`)
      // err.name = 'invalidFilter'
    }
    if (err) {
      let scimType = errorStatus(err, isScimv2, ctx)
      const e = jsonErr(config.scim.version, pluginName, ctx.status, err, scimType)
      ctx.body = e
      return
    }

    //
    // Get user request for retreving common unique attributes:
    // GET = /Users?filter=userName eq "jsmith"&attributes=id,userName
    // GET = /Users?filter=id eq "jsmith"&attributes=id,userName
    //
    // Get user request for retreving all attributes:
    // GET = /Users?filter=userName eq "jsmith"&attributes=ims,locale,name.givenName,externalId,preferredLanguage,userType,id,title,timezone,name.middleName,name.familyName,nickName,name.formatted,meta.location,userName,name.honorificSuffix,meta.version,meta.lastModified,meta.created,name.honorificPrefix,emails,phoneNumbers,photos,x509Certificates.value,profileUrl,roles,active,addresses,displayName,entitlements
    //
    //  ---- retreive all users for a spesific group ----
    //
    // "user member of group" => default - Group having multivalue attribute members containing users userName/id
    // GET = /Groups?filter=members.value eq "bjensen"&attributes=id,displayName,members.value
    //
    // "group member of user" => User having multivalue attribute groups containing value=GroupName
    // GET = /Users?filter=groups.value eq "UserGroup-1"&attributes=groups.value,userName
    //
    //   ---- Azure AD to SCIM Users ----
    //
    // Default SCIM attribute mapping have:
    //   externalId mapped to mailNickname (matching precedence #1)
    //   userName mapped to userPrincipalName
    //
    // Precedence decides filter attribute sent to ScimGateway
    // GET = /scim/Users?filter=externalId eq "jarle_elshaug"
    //
    // ScimGateway accepts externalId (as matching precedence) instead of userName, but userName and externalId must
    // then be mapped to the same AD attribte e.g:
    //
    //   externalId mapped to mailNickname (matching precedence #1)
    //   userName mapped to mailNickname
    // or:
    //   externalId mapped to userPrincipalName (matching precedence #1)
    //   userName mapped to userPrincipalName
    //
    // ---- GROUP ----
    //
    // Get group:
    // GET /Groups?filter=displayName eq "Employees"&attributes=externalId,id,members.value,displayName
    //
    // Azure AD:
    // GET /scim/Groups?excludedAttributes=members&filter=externalId eq "MyGroup"
    //
    // Get group members:
    // GET = /Groups?filter=members.value eq "<user-id>"&attributes=members.value,displayName&startIndex=1&count=100
    //
    //   ---- Azure AD to SCIM Groups ----
    //
    // Default SCIM attribute for GROUP mapping have:
    //   externalId mapped to displayName (matching precedence #1)
    //   displayName mapped to mailNickname
    //
    // ScimGateway accepts externalId (as matching precedence) instead of displayName, but displayName and externalId must
    // then be mapped to the same AD attribute e.g:
    //
    //   externalId mapped to displayName (matching precedence #1)
    //   displayName mapped to displayName
    //
    // ---- servicePlans ----
    // GET /servicePlans?filter=servicePlanName+eq+%22EXCHANGE_S_FOUNDATION%22&attributes=servicePlanName
    //
    // ---- no filtering - simpel filtering - advanced filtering ----
    // GET /Users
    // GET /Groups
    // GET /Users?attributes=userName&startIndex=1&count=100
    // GET /Groups?attributes=displayName
    // GET /Users?filter=meta.created ge "2010-01-01T00:00:00Z"&attributes=userName,id,name.familyName,meta.created
    // GET /Users?filter=emails.value co "@example.com"&attributes=userName,name.familyName,emails&sortBy=name.familyName&sortOrder=descending

    let info = ''
    if (getObj.operator === 'eq' && ['id', 'userName', 'externalId', 'displayName', 'members.value'].includes(getObj.attribute)) info = ` ${getObj.attribute}=${getObj.value}`

    logger.debug(`${gwName}[${pluginName}] [Get ${handle.description}s]${info}`)
    logger.debug(`${gwName}[${pluginName}] calling "${handle.getMethod}" and awaiting result`)
    try {
      getObj.startIndex = ctx.query.startIndex ? parseInt(ctx.query.startIndex) : undefined
      getObj.count = ctx.query.count ? parseInt(ctx.query.count) : undefined
      if (getObj.startIndex && !getObj.count) getObj.count = 200 // defaults to 200 (plugin may override)
      if (getObj.count && !getObj.startIndex) getObj.startIndex = 1

      const res = await this[handle.getMethod](ctx.params.baseEntity, utils.copyObj(getObj), ctx.query.attributes ? ctx.query.attributes.split(',').map(item => item.trim()) : [], ctx.ctxCopy)
      let scimdata = {
        Resources: [],
        totalResults: null
      }
      if (res) {
        if (res.Resources && Array.isArray(res.Resources)) {
          scimdata.Resources = res.Resources
          scimdata.totalResults = res.totalResults
        } else if (Array.isArray(res)) scimdata.Resources = res
        else if (typeof (res) === 'object' && Object.keys(res).length > 0) scimdata.Resources[0] = res
      }

      // check for user attribute groups and include if needed
      if (handle.getMethod === handler.users.getMethod && !config.scim.groupMemberOfUser) { // groupMemberOfUser can be set to true for skipping
        let arrAttr = []
        if (ctx.query.attributes) arrAttr = ctx.query.attributes.split(',')
        if ((!ctx.query.attributes || arrAttr.includes('groups')) && typeof this[handler.groups.getMethod] === 'function') { // include groups
          for (let j = 0; j < scimdata.Resources.length; j++) {
            const userObj = scimdata.Resources[j]
            if (!userObj.id) break
            if (userObj.groups) break
            logger.debug(`${gwName}[${pluginName}] calling "${handler.groups.getMethod}" and awaiting result - groups to be included`)
            let res
            try {
              res = await this[handler.groups.getMethod](ctx.params.baseEntity, { attribute: 'members.value', operator: 'eq', value: decodeURIComponent(userObj.id) }, ['id', 'displayName'], ctx.ctxCopy) // await scimgateway.getUserGroups(baseEntity, userObj.id, 'members.value,displayName')
            } catch (err) {} // method may be implemented but throwing error like groups not supported/implemented
            if (res && res.Resources && Array.isArray(res.Resources) && res.Resources.length > 0) {
              userObj.groups = []
              for (let i = 0; i < res.Resources.length; i++) {
                if (!res.Resources[i].id) continue
                const el = {}
                el.value = res.Resources[i].id
                if (res.Resources[i].displayName) el.display = res.Resources[i].displayName
                if (isScimv2) el.type = 'direct'
                else el.type = { value: 'direct' }
                userObj.groups.push(el) // { "value": "Admins", "display": "Admins", "type": "direct"}
              }
            }
          }
        }
      }

      let location = ctx.origin + ctx.path
      if (ctx.query.attributes || (ctx.query.excludedAttributes && ctx.query.excludedAttributes.includes('meta'))) location = null
      for (let i = 0; i < scimdata.Resources.length; i++) {
        scimdata.Resources[i] = addPrimaryAttrs(scimdata.Resources[i])
        scimdata.Resources[i] = utils.stripObj(scimdata.Resources[i], ctx.query.attributes, ctx.query.excludedAttributes)
      }
      scimdata = addResources(scimdata, ctx.query.startIndex, ctx.query.sortBy, ctx.query.sortOrder)
      scimdata = addSchemas(scimdata, handle.description, isScimv2, location)

      ctx.body = scimdata
      await fetchNotification(ctx, 'onSuccess', caches, verifyTracing)
    } catch (err) {
      let scimType = errorStatus(err, isScimv2, ctx)
      const e = jsonErr(config.scim.version, pluginName, ctx.status, err, scimType)
      ctx.body = e
      await fetchNotification(ctx, 'onError', caches, verifyTracing)
    }
    endSpan(ctx, span, requestSpan)
    })
  })

  // ==========================================
  //           createUser
  //           createGroup
  // ==========================================
  //
  // POST = /Users
  // Body contains user attributes including userName (userID)
  // Body example:
  // {"active":true,"name":{"familyName":"Elshaug","givenName":"Jarle"},"schemas":["urn:scim:schemas:core:1.0"],"userName":"jael01"}
  //
  // POST = /Groups
  // Body contains group attributes including displayName (group name)
  // Body example:
  // {"displayName":"MyGroup","externalId":"MyExternal","schemas":["urn:scim:schemas:core:1.0"]}
  //
  router.post([`/(|scim/)(!${undefined}|Users|Groups)(|.json)(|.xml)`,
  `/:baseEntity/(|scim/)(!${undefined}|Users|Groups)(|.json)(|.xml)`], async (ctx) => {
    return await TelemetryWrapper(api, async () => {
      requestSpan = verifyTracing(ctx,  'Request')

    let u = ctx.originalUrl.substr(ctx.originalUrl.lastIndexOf('/') + 1) // u = Users<.json|.xml>, Groups<.json|.xml>
    u = u.split('?')[0] // Users?AzureAdScimPatch062020
    const handle = handler[u.split('.')[0]]
    logger.debug(`${gwName}[${pluginName}] [Create ${handle.description}]`)
    let jsonBody = ctx.request.body
    const strBody = JSON.stringify(jsonBody)
    if (strBody === '{}') {
      ctx.status = 500
      let err = new Error('Not accepting empty or none JSON formatted POST requests')
      err = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = err
      return
    } else if (handle.createMethod === 'createUser' && !jsonBody.userName && !jsonBody.externalId) {
      ctx.status = 500
      let err = new Error('userName or externalId is mandatory')
      err = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = err
      return
    } else if (handle.createMethod === 'createGroup' && !jsonBody.displayName && !jsonBody.externalId) {
      ctx.status = 500
      let err = new Error('displayName or externalId is mandatory')
      err = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = err
      return
    }

    logger.debug(`${gwName}[${pluginName}] POST ${ctx.originalUrl} body=${strBody}`)
    jsonBody = JSON.parse(strBody) // using a copy
    const [scimdata, err] = ScimGateway.prototype.convertedScim(jsonBody)
    logger.debug(`${gwName}[${pluginName}] convertedBody=${JSON.stringify(scimdata)}`)
    if (err) {
      ctx.status = 500
      const e = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = e
      return
    }
    logger.debug(`${gwName}[${pluginName}] calling "${handle.createMethod}" and awaiting result`)
    delete jsonBody.id // in case included in request
    try {
      const res = await this[handle.createMethod](ctx.params.baseEntity, scimdata, ctx.ctxCopy)
      for (const key in res) { // merge any result e.g: {'id': 'xxxx'}
        jsonBody[key] = res[key]
      }

      if (!jsonBody.id) { // retrieve all attributes including id
        let obj
        try {
          if (handle.createMethod === 'createUser') {
            if (jsonBody.userName) {
              jsonBody.id = jsonBody.userName
              obj = await this[handle.getMethod](ctx.params.baseEntity, { attribute: 'userName', operator: 'eq', value: jsonBody.userName }, [], ctx.ctxCopy)
            } else if (jsonBody.externalId) {
              jsonBody.id = jsonBody.externalId
              obj = await this[handle.getMethod](ctx.params.baseEntity, { attribute: 'externalId', operator: 'eq', value: jsonBody.externalId }, [], ctx.ctxCopy)
            }
          } else if (handle.createMethod === 'createGroup') {
            if (jsonBody.externalId) {
              jsonBody.id = jsonBody.externalId
              obj = await this[handle.getMethod](ctx.params.baseEntity, { attribute: 'externalId', operator: 'eq', value: jsonBody.externalId }, [], ctx.ctxCopy)
            } else if (jsonBody.displayName) {
              jsonBody.id = jsonBody.displayName
              obj = await this[handle.getMethod](ctx.params.baseEntity, { attribute: 'displayName', operator: 'eq', value: jsonBody.displayName }, [], ctx.ctxCopy)
            }
          }
        } catch (err) { }
        if (obj && obj.id) jsonBody = obj
      }

      const location = `${ctx.origin}${ctx.path}/${jsonBody.id}`
      if (!jsonBody.meta) jsonBody.meta = {}
      jsonBody.meta.location = location
      delete jsonBody.password
      jsonBody = addPrimaryAttrs(jsonBody)
      ctx.set('Location', location)
      ctx.status = 201
      ctx.body = jsonBody
      await fetchNotification(ctx, 'onSuccess', caches, verifyTracing)
    } catch (err) {
      let scimType = errorStatus(err, isScimv2, ctx)
      const e = jsonErr(config.scim.version, pluginName, ctx.status, err, scimType)
      ctx.body = e
      await fetchNotification(ctx, 'onError', caches, verifyTracing)
    }
    endSpan(ctx, span, requestSpan)
  })
  }) // post

  // ==========================================
  //           deleteUser
  //           deleteGroup
  // ==========================================
  //
  // DELETE /Users/<id>
  // DELETE /Groups/<id>
  // Note user: using id (not userName). getUsers should therefore set id = userName (userID) e.g. bjensen
  // => We then have: DELETE /Users/bjensen
  // Note groups: using id (not displayName). getGroups should therefore set id = displayName (groupID) e.g. Employees
  // => We then have: DELETE /Groups/Employees
  //
  router.delete([`/(|scim/)(!${undefined}|Users|Groups)/:id`,
  `/:baseEntity/(|scim/)(!${undefined}|Users|Groups)/:id`], async (ctx) => {
    return await TelemetryWrapper(api, async () => {
      requestSpan = verifyTracing(ctx,  'Request')

    let u = ctx.originalUrl.substr(0, ctx.originalUrl.lastIndexOf('/'))
    u = u.substr(u.lastIndexOf('/') + 1) // u = Users, Groups
    const handle = handler[u]
    const id = ctx.params.id
    logger.debug(`${gwName}[${pluginName}] [Delete ${handle.description}] id=${id}`)
    logger.debug(`${gwName}[${pluginName}] calling "${handle.deleteMethod}" and awaiting result`)

    try {
      await this[handle.deleteMethod](ctx.params.baseEntity, id, ctx.ctxCopy)
      ctx.status = 204
      await fetchNotification(ctx, 'onSuccess', caches, verifyTracing)
    } catch (err) {
      let scimType = errorStatus(err, isScimv2, ctx)   
      const e = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = e
      await fetchNotification(ctx, 'onError', caches, verifyTracing)
    }
    endSpan(ctx, span, requestSpan)
  })
  }) // delete

  // ==========================================
  //          modifyUser
  //          modifyGroup
  // ==========================================
  //
  // PATCH = /Users/<id>
  // PATCH = /Users/4aa37ddc-4985-4009-ab24-df42d37e2810
  // Note, using id (not userName). getUsers should therefore set id = userName (userID)
  // => We then have: PATCH /Users/bjensen
  //
  // Body contains user attributes to be updated
  // example: {"active":true}
  //
  // Multi-value attributes excluding user attribute 'groups' are customized from array to object based on type
  // This is done for simplifying plugin-code. For more information please see method convertedScim / convertedScim20
  //
  // PATCH = /Groups/<id>
  // PATCH = /Groups/4aa37ddc-4985-4009-ab24-df42d37e2810
  // Note, using id (not displayName). getGroups should therefore set id = displayName
  // => We then have: PATCH = /Groups/Employees
  //
  // Body contains groups attributes to be updated
  // example: {"members":[{"value":"bjensen"}],"schemas":["urn:scim:schemas:core:1.0"]}
  //
  router.patch([`/(|scim/)(!${undefined}|Users|Groups|servicePlans)/:id`,
  `/:baseEntity/(|scim/)(!${undefined}|Users|Groups|servicePlans)/:id`], async (ctx) => {
    return await TelemetryWrapper(api, async () => {
      requestSpan = verifyTracing(ctx,  'Request')
    if (ctx.query.attributes) ctx.query.attributes = ctx.query.attributes.split(',').map(item => item.trim()).join()
    if (ctx.query.excludedAttributes) ctx.query.excludedAttributes = ctx.query.excludedAttributes.split(',').map(item => item.trim()).join()
    let u = ctx.originalUrl.substr(0, ctx.originalUrl.lastIndexOf('/'))
    u = u.substr(u.lastIndexOf('/') + 1) // u = Users, Groups
    const handle = handler[u]
    const id = decodeURIComponent(ctx.params.id)
    const jsonBody = ctx.request.body
    const strBody = JSON.stringify(jsonBody)
    if (strBody === '{}') {
      ctx.status = 500
      let err = new Error('Not accepting empty or none JSON formatted PATCH request')
      err = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = err
    } else {
      logger.debug(`${gwName}[${pluginName}] [Modify ${handle.description}] id=${id}`)
      let scimdata, err
      if (jsonBody.Operations) [scimdata, err] = ScimGateway.prototype.convertedScim20(jsonBody) // v2.0
      else [scimdata, err] = ScimGateway.prototype.convertedScim(jsonBody) // v1.1
      logger.debug(`${gwName}[${pluginName}] convertedBody=${JSON.stringify(scimdata)}`)
      if (err) {
        ctx.status = 500
        const e = jsonErr(config.scim.version, pluginName, ctx.status, err)
        ctx.body = e
        return
      }
      logger.debug(`${gwName}[${pluginName}] calling "${handle.modifyMethod}" and awaiting result`)
      try {
        await this[handle.modifyMethod](ctx.params.baseEntity, id, scimdata, ctx.ctxCopy)
        // include full object in response
        if (handle.getMethod !== handler.users.getMethod && handle.getMethod !== handler.groups.getMethod) { // getUsers or getGroups not implemented
          ctx.status = 204
          return
        }
        logger.debug(`${gwName}[${pluginName}] calling "${handle.getMethod}" and awaiting result`)
        const res = await this[handle.getMethod](ctx.params.baseEntity, { attribute: 'id', operator: 'eq', value: id }, ctx.query.attributes ? ctx.query.attributes.split(',').map(item => item.trim()) : [], ctx.ctxCopy)
        scimdata = {
          Resources: [],
          totalResults: null
        }
        if (res) {
          if (res.Resources && Array.isArray(res.Resources)) {
            scimdata.Resources = res.Resources
            scimdata.totalResults = res.totalResults
          } else if (Array.isArray(res)) scimdata.Resources = res
          else if (typeof (res) === 'object' && Object.keys(res).length > 0) scimdata.Resources[0] = res
        }
        if (scimdata.Resources.length !== 1) throw new Error(`using ${handle.getMethod} to retrive user ${id} after ${handle.modifyMethod} but response did not include user object`)
        const location = ctx.origin + ctx.path
        ctx.set('Location', location)
        scimdata.Resources[0] = addPrimaryAttrs(scimdata.Resources[0])
        scimdata = utils.stripObj(scimdata.Resources[0], ctx.query.attributes, ctx.query.excludedAttributes)
        scimdata = addSchemas(scimdata, handle.description, isScimv2)
        ctx.status = 200
        ctx.body = scimdata
        await fetchNotification(ctx, 'onSuccess', caches, verifyTracing, ScimGateway.prototype.convertedScim20(ctx.request.body))
      } catch (err) {
        let scimType = errorStatus(err, isScimv2, ctx)
        const e = jsonErr(config.scim.version, pluginName, ctx.status, err, scimType)
        ctx.body = e
        await fetchNotification(ctx, 'onError', caches, verifyTracing, ScimGateway.prototype.convertedScim20(ctx.request.body))
      }
    }
    endSpan(ctx, span, requestSpan)
  })
  }) // patch

  // ==========================================
  //          REPLACE USER
  //          REPLACE GROUP
  // ==========================================
  router.put([`/(|scim/)(!${undefined}|Users|Groups|servicePlans)/:id`,
  `/:baseEntity/(|scim/)(!${undefined}|Users|Groups|servicePlans)/:id`], async (ctx) => {
    return await TelemetryWrapper(api, async () => {
      requestSpan = verifyTracing(ctx,  'Request')

    let u = ctx.originalUrl.substr(0, ctx.originalUrl.lastIndexOf('/'))
    u = u.substr(u.lastIndexOf('/') + 1) // u = Users, Groups
    const handle = handler[u]
    const id = ctx.params.id
    const jsonBody = ctx.request.body
    const strBody = JSON.stringify(jsonBody)
    if (strBody === '{}') {
      ctx.status = 500
      let err = new Error('Not accepting empty or none JSON formatted PUT requests')
      err = jsonErr(config.scim.version, pluginName, ctx.status, err)
      ctx.body = err
    } else {
      logger.debug(`${gwName}[${pluginName}] PUT ${ctx.originalUrl} body=${strBody}`)
      try {
        // get current object
        logger.debug(`${gwName}[${pluginName}] calling "${handle.getMethod}" and awaiting result`)
        let res = await this[handle.getMethod](ctx.params.baseEntity, { attribute: 'id', operator: 'eq', value: id }, [], ctx.ctxCopy)

        let currentObj = {}
        if (res && res.Resources && Array.isArray(res.Resources) && res.Resources.length === 1) currentObj = res.Resources[0]
        else if (Array.isArray(res) && res.length === 1) currentObj = res[0]
        else if (res && typeof (res) === 'object' && Object.keys(res).length > 0) currentObj = res
        else throw Error(`put using method ${handle.getMethod} got unexpected response: ${JSON.stringify(res)}`)

        const clearedObj = clearObjectValues(currentObj)
        delete clearedObj.active
        delete clearedObj.password
        delete clearedObj.meta

        // usePutSoftSync=true prevents removing existing roles (only add roles)
        if (config.scim.usePutSoftSync) {
          if (clearedObj.roles && Array.isArray(clearedObj.roles)) {
            for (let i = 0; i < clearedObj.roles.length; i++) {
              if (clearedObj.roles[i].operation && clearedObj.roles[i].operation === 'delete') {
                clearedObj.roles.splice(i, 1) // delete
                i -= 1
              }
            }
          }
        }

        // merge cleared object with the new
        const newObj = utils.extendObj(clearedObj, jsonBody)
        delete newObj.id
        delete newObj.userName
        delete newObj.externalId
        delete newObj.groups // do not support "group member of users"
        delete newObj.schemas
        delete newObj.meta
        if (handle.getMethod === handler.groups.getMethod) delete newObj.displayName

        let [scimdata, err] = ScimGateway.prototype.convertedScim(newObj)
        if (err) throw err

        // update object
        logger.debug(`${gwName}[${pluginName}] calling "${handle.modifyMethod}" and awaiting result`)
        await this[handle.modifyMethod](ctx.params.baseEntity, id, scimdata, ctx.ctxCopy)

        // add/remove groups
        if (jsonBody.groups && Array.isArray(jsonBody.groups)) { // only if groups included, { "groups": [] } will remove all existing
          if (typeof this[handler.groups.getMethod] !== 'function' || typeof this[handler.groups.modifyMethod] !== 'function') {
            throw new Error('replaceUser error: put operation can not be fully completed for the user`s groups, methods like getGroups() and modifyGroup() are not implemented')
          }
          let currentGroups
          if (currentObj.groups && Array.isArray(currentObj.groups)) currentGroups = currentObj.groups
          else { // try to get current groups the standard way
            let res
            try {
              res = await this[handler.groups.getMethod](ctx.params.baseEntity, { attribute: 'members.value', operator: 'eq', value: decodeURIComponent(id) }, ['id', 'displayName'], ctx.ctxCopy)
            } catch (err) {} // method may be implemented but throwing error like groups not supported/implemented
            currentGroups = []
            if (res && res.Resources && Array.isArray(res.Resources) && res.Resources.length > 0) {
              for (let i = 0; i < res.Resources.length; i++) {
                if (!res.Resources[i].id) continue
                const el = {}
                el.value = res.Resources[i].id
                if (res.Resources[i].displayName) el.display = res.Resources[i].displayName
                currentGroups.push(el) // { "value": "Admins", "display": "Admins"}
              }
            }
          }
          currentGroups = currentGroups.map((el) => {
            if (el.value) {
              el.value = decodeURIComponent(el.value)
            }
            return el
          })

          const addGrps = []
          const removeGrps = []
          // add
          for (let i = 0; i < jsonBody.groups.length; i++) {
            if (!jsonBody.groups[i].value) continue
            jsonBody.groups[i].value = decodeURIComponent(jsonBody.groups[i].value)
            let found = false
            for (let j = 0; j < currentGroups.length; j++) {
              if (jsonBody.groups[i].value === currentGroups[j].value) {
                found = true
                break
              }
            }
            if (!found && jsonBody.groups[i].value) addGrps.push(jsonBody.groups[i].value)
          }
          // remove
          for (let i = 0; i < currentGroups.length; i++) {
            let found = false
            for (let j = 0; j < jsonBody.groups.length; j++) {
              if (!jsonBody.groups[j].value) continue
              jsonBody.groups[j].value = decodeURIComponent(jsonBody.groups[j].value)
              if (currentGroups[i].value === jsonBody.groups[j].value) {
                found = true
                break
              }
            }
            if (!found && currentGroups[i].value) removeGrps.push(currentGroups[i].value)
          }

          const addGroups = async (grp) => {
            const obj = { members: [{ value: id }] }
            return await this[handler.groups.modifyMethod](ctx.params.baseEntity, grp, obj, ctx.ctxCopy)
          }

          const removeGroups = async (grp) => {
            const obj = { members: [{ operation: 'delete', value: id }] }
            return await this[handler.groups.modifyMethod](ctx.params.baseEntity, grp, obj, ctx.ctxCopy)
          }

          let errRemove
          if (!config.scim.usePutSoftSync) { // default will remove any existing groups not included, usePutSoftSync=true prevents removing existing groups (only add groups)
            await Promise.all(removeGrps.map((grp) => removeGroups(grp)))
              .then()
              .catch((err) => {
                errRemove = err
              })
          }

          let errAdd
          await Promise.all(addGrps.map((grp) => addGroups(grp)))
            .then()
            .catch((err) => {
              errAdd = err
            })

          let errMsg = ''
          if (errRemove) errMsg = `removeGroups error: ${errRemove.message}`
          if (errAdd) errMsg += `${errMsg ? ' ' : ''}addGroups error: ${errAdd.message}`
          if (errMsg) throw new Error(errMsg)
        }

        // get updated object
        logger.debug(`${gwName}[${pluginName}] calling "${handle.getMethod}" and awaiting result`)
        res = await this[handle.getMethod](ctx.params.baseEntity, { attribute: 'id', operator: 'eq', value: id }, [], ctx.ctxCopy)

        scimdata = {}
        if (res && res.Resources && Array.isArray(res.Resources) && res.Resources.length === 1) scimdata = res.Resources[0]
        else if (Array.isArray(res) && res.length === 1) scimdata = res[0]
        else if (res && typeof (res) === 'object' && Object.keys(res).length > 0) scimdata = res
        else throw Error(`put using method ${handle.getMethod} got unexpected response: ${JSON.stringify(res)}`)

        // include groups
        if (handle.getMethod === handler.users.getMethod && typeof this[handler.groups.getMethod] === 'function') {
          logger.debug(`${gwName}[${pluginName}] calling "${handler.groups.getMethod}" and awaiting result`)
          const res = await this[handler.groups.getMethod](ctx.params.baseEntity, { attribute: 'members.value', operator: 'eq', value: id }, ['id', 'displayName'], ctx.ctxCopy)
          let grps = []
          if (res && res.Resources && Array.isArray(res.Resources)) grps = res.Resources
          else if (Array.isArray(res)) grps = res
          else if (res && typeof (res) === 'object' && Object.keys(res).length > 0) grps = [res]
          else throw Error(`put using method ${handler.groups.getMethod} got unexpected response: ${JSON.stringify(res)}`)

          if (grps.length > 0) {
            scimdata.groups = []
            for (let i = 0; i < grps.length; i++) {
              const el = {}
              el.value = grps[i].id
              if (grps[i].displayName) el.display = grps[i].displayName
              if (isScimv2) el.type = 'direct'
              else el.type = { value: 'direct' }
              if (el.value) scimdata.groups.push(el) // { "value": "Admins", "display": "Admins", "type": "direct"}
            }
          }
        }

        const location = ctx.origin + ctx.path
        ctx.set('Location', location)
        scimdata = addSchemas(scimdata, handle.description, isScimv2)
        ctx.status = 200
        ctx.body = scimdata
        await fetchNotification(ctx, 'onSuccess', caches, verifyTracing)
      } catch (err) {
        let scimType = errorStatus(err, isScimv2, ctx)
        const e = jsonErr(config.scim.version, pluginName, ctx.status, err)
        ctx.body = e
        await fetchNotification(ctx, 'onError', caches, verifyTracing)
      }
    }
    endSpan(ctx, span, requestSpan)
  })
  })


  // ==========================================
  // Starting up...
  // ==========================================

  for (let i = 0; i < logger.transports.length; i++) { // loglevel=off => turn off logging
    if (logger.transports[i].name === 'file' && config.log.loglevel.file && config.log.loglevel.file.toLowerCase() === 'off') {
      logger.transports[i].silent = true
    } else if (logger.transports[i].name === 'console' && config.log.loglevel.console && config.log.loglevel.console.toLowerCase() === 'off') {
      logger.transports[i].silent = true
    }
  }

  logger.info('===================================================================')

  if (config.localhostonly === true) {
    logger.info(`${gwName}[${pluginName}] denying other clients than localhost (127.0.0.1)`)
    if (config.certificate && config.certificate.key && config.certificate.cert) {
      // SSL
      server = https.createServer({
        key: fs.readFileSync(configDir + '/certs/' + config.certificate.key),
        cert: fs.readFileSync(configDir + '/certs/' + config.certificate.cert)
      }, app.callback()).listen(config.port, 'localhost')
      logger.info(`${gwName}[${pluginName}] now listening SCIM ${config.scim.version} on TLS port ${config.port}...\n`)
    } else if (config.certificate && config.certificate.pfx && config.certificate.pfx.bundle) {
      // SSL using PFX / PKCS#12
      server = https.createServer({
        pfx: fs.readFileSync(configDir + '/certs/' + config.certificate.pfx.bundle),
        passphrase: pwPfxPassword
      }, app.callback()).listen(config.port, 'localhost')
      logger.info(`${gwName}[${pluginName}] now listening SCIM ${config.scim.version} on TLS port ${config.port}...\n`)
    } else {
      // none SSL
      server = http.createServer(app.callback()).listen(config.port, 'localhost')
      logger.info(`${gwName}[${pluginName}] now listening SCIM ${config.scim.version} on port ${config.port}...\n`)

    }
  } else {
    logger.info(`${gwName}[${pluginName}] accepting requests from all clients`)
    if (config.certificate && config.certificate.key && config.certificate.cert) {
      // SSL self signed cert e.g: openssl req -nodes -newkey rsa:2048 -x509 -sha256 -days 3650 -keyout key.pem -out cert.pem -subj "/O=NodeJS/OU=Testing/CN=<FQDN>"
      // Note, self signed certificate (cert.pem) also needs to be imported at the CA Connector Server
      server = https.createServer({
        key: fs.readFileSync(configDir + '/certs/' + config.certificate.key),
        cert: fs.readFileSync(configDir + '/certs/' + config.certificate.cert),
        ca: (config.certificate.ca) ? fs.readFileSync(configDir + '/certs/' + config.certificate.ca) : null
      }, app.callback()).listen(config.port)
      logger.info(`${gwName}[${pluginName}] now listening SCIM ${config.scim.version} on TLS port ${config.port}...\n`)
    } else if (config.certificate && config.certificate.pfx && config.certificate.pfx.bundle) {
      // SSL using PFX / PKCS#12
      server = https.createServer({
        pfx: fs.readFileSync(configDir + '/certs/' + config.certificate.pfx.bundle),
        passphrase: pwPfxPassword
      }, app.callback()).listen(config.port)
      logger.info(`${gwName}[${pluginName}] now listening SCIM ${config.scim.version} on TLS port ${config.port}...\n`)
    } else {
      // none SSL
      server = http.createServer(app.callback()).listen(config.port)
      logger.info(`${gwName}[${pluginName}] now listening SCIM ${config.scim.version} on port ${config.port}...\n`)
    }
  }

  function onSignal () {
    logger.info('server is starting cleanup')
    return Promise.all([
      // your clean logic, like closing database connections
    ])
  }

  function onShutdown () {
    logger.info('cleanup finished, server is shutting down')
  }

  function beforeShutdown () {
    return new Promise(resolve => {
      setTimeout(resolve, config.kubernetes.shutdownTimeout || 15000)
    })
  }

  function healthCheck () {
    return Promise.resolve(
      // optionally include a resolve value to be included as
      // info in the health check response
    )
  }
  const options = {
    // health check options
    healthChecks: {
      '/healthcheck': healthCheck, // a function returning a promise indicating service health,
      verbatim: true // [optional = false] use object returned from /healthcheck verbatim in response
    },

    // cleanup options
    timeout: config.kubernetes.forceExitTimeout || 1000, // [optional = 1000] number of milliseconds before forceful exiting
    beforeShutdown, // [optional] called before the HTTP server starts its shutdown
    onSignal, // [optional] cleanup function, returning a promise (used to be onSigterm)
    onShutdown // [optional] called right before exiting
  }

  if (config.kubernetes.enabled) createTerminus(server, options)

  // set loglevel according to config
  const arrValidLevel = ['silly', 'debug', 'verbose', 'info', 'warn', 'error']
  for (let i = 0; i < logger.transports.length; i++) {
    if (logger.transports[i].name === 'file') config.log.loglevel.file && arrValidLevel.includes(config.log.loglevel.file.toLowerCase()) ? logger.transports[i].level = config.log.loglevel.file : logger.transports[i].level = 'debug'
    else if (logger.transports[i].name === 'console') config.log.loglevel.console && arrValidLevel.includes(config.log.loglevel.console.toLowerCase()) ? logger.transports[i].level = config.log.loglevel.console : logger.transports[i].level = 'debug'
  }

  log.emailOnError = async (msg) => { // sending mail on error
    if (!config.emailOnError || !config.emailOnError.smtp || !(config.emailOnError.smtp.enabled === true) || isMailLock) return null // not sending mail
    isMailLock = true

    setTimeout(function () { // release lock after "sendInterval" minutes
      isMailLock = false
    }, (config.emailOnError.smtp.sendInterval || 15) * 1000 * 60)

    const bodyHtml = `<html><body> 
          <p>${msg}</p> 
          <br> 
          <p><strong>This is an automatically generated email - please do NOT reply to this email or forward to others</strong></p> 
          </body></html>`

    const smtpConfig = {
      host: config.emailOnError.smtp.host, // e.g. smtp.office365.com
      port: config.emailOnError.smtp.port || 587,
      proxy: config.emailOnError.smtp.proxy || null,
      secure: (config.emailOnError.smtp.port === 465), // false on 25/587
      tls: { ciphers: 'TLSv1.2' }
    }
    if (config.emailOnError.smtp.authenticate) {
      smtpConfig.auth = {}
      smtpConfig.auth.user = config.emailOnError.smtp.username
      smtpConfig.auth.pass = config.emailOnError.smtp.password
    }

    const transporter = nodemailer.createTransport(smtpConfig)
    const mailOptions = {
      from: config.emailOnError.smtp.username, // sender address
      to: config.emailOnError.smtp.to, // list of receivers - comma separated
      cc: config.emailOnError.smtp.cc,
      subject: 'ScimGateway error message',
      html: bodyHtml // 'text': bodyText
    }

    transporter.sendMail(mailOptions, function (err, info) {
      if (err) logger.error(`${gwName}[${pluginName}] mailOnError sending failed: ${err.message}`)
      else logger.debug(`${gwName}[${pluginName}] mailOnError sent to: ${config.emailOnError.smtp.to}${(config.emailOnError.smtp.cc) ? ',' + config.emailOnError.smtp.cc : ''}`)
    })
    return null
  } // emailOnError

  const gracefulShutdown = function () {
    logger.debug(`${gwName}[${pluginName}] received terminate/kill signal - closing connections and exit`)
    for (let i = logger.transports.length - 1; i >= 0; i--) { // enable info logging
      try { logger.transports[i].level = 'info' } catch (e) { }
    }
    logger.info(`${gwName}[${pluginName}] pheww... ${requestCounter} requests have been processed in the period ${startTime} - ${utils.timestamp()}\n`)
    logger.close()
    server.close(function () {
      setTimeout(function () { // plugins may also use SIGTERM/SIGINT
        process.exit(0)
      }, 0.5 * 1000)
    })
    setTimeout(function () { // problem closing server connections in time due to keep-alive sessions (active browser connection?), now forcing exit
      process.exit(1)
    }, 2 * 1000)
  }

  process.on('unhandledRejection', (err) => { // older versions of V8, unhandled promise rejections are silently dropped
    logger.error(`${gwName}[${pluginName}] Async function with unhandledRejection: ${err.stack}`)
  })
  process.once('SIGTERM', gracefulShutdown) // kill (windows subsystem lacks signaling support for process.kill)
  process.once('SIGINT', gracefulShutdown) // Ctrl+C

  //
  // exported methods inside ScimGateway because of local defined variable multiValueTypes
  //
  ScimGateway.prototype.isMultiValueTypes = function isMultiValueTypes (attr) { // emails
    return multiValueTypes.includes(attr)
  }

  // Multi-value attributes are customized from array to object based on type
  // except: groups, members and roles
  // e.g "emails":[{"value":"bjensen@example.com","type":"work"}] => {"emails": {"work": {"value":"bjensen@example.com","type":"work"}}}
  // Cleared values are set as user attributes with blank value ""
  // e.g {meta:{attributes:['name.givenName','title']}} => {"name": {"givenName": ""}), "title": ""}
  ScimGateway.prototype.convertedScim = function convertedScim (obj) {
    let err = null
    const scimdata = utils.copyObj(obj)
    if (scimdata.schemas) delete scimdata.schemas
    const newMulti = {}
    for (const key in scimdata) {
      if (Array.isArray(scimdata[key]) && (scimdata[key].length > 0)) {
        if (key === 'groups' || key === 'members' || key === 'roles') {
          scimdata[key].forEach(function (element, index) {
            if (element.value) scimdata[key][index].value = decodeURIComponent(element.value)
          })
        } else if (multiValueTypes.includes(key)) { // "type converted object" // groups, roles, member and scim.excludeTypeConvert are not included
          const tmpAddr = []
          scimdata[key].forEach(function (element, index) {
            if (!element.type) element.type = 'undefined' // "none-type"
            if (element.operation && element.operation === 'delete') { // add as delete if same type not included as none delete
              const arr = scimdata[key].filter(obj => obj.type && obj.type === element.type && !obj.operation)
              if (arr.length < 1) {
                if (!newMulti[key]) newMulti[key] = {}
                if (newMulti[key][element.type]) {
                  if (['addresses'].includes(key)) { // not checking type, but the others have to be unique
                    for (const i in element) {
                      if (i !== 'type') {
                        if (tmpAddr.includes(i)) {
                          err = new Error(`'type converted object' ${key} - includes more than one element having same ${i}, or ${i} is blank on more than one element - note, setting configuration scim.skipTypeConvert=true will disable this logic/check`)
                        }
                        tmpAddr.push(i)
                      }
                    }
                  } else {
                    err = new Error(`'type converted object' ${key} - includes more than one element having same type, or type is blank on more than one element - note, setting configuration scim.skipTypeConvert=true will disable this logic/check`)
                  }
                }
                newMulti[key][element.type] = {}
                for (const i in element) {
                  newMulti[key][element.type][i] = element[i]
                }
                newMulti[key][element.type].value = '' // delete
              }
            } else {
              if (!newMulti[key]) newMulti[key] = {}
              if (newMulti[key][element.type]) {
                if (['addresses'].includes(key)) { // not checking type, but the others have to be unique
                  for (const i in element) {
                    if (i !== 'type') {
                      if (tmpAddr.includes(i)) {
                        err = new Error(`'type converted object' ${key} - includes more than one element having same ${i}, or ${i} is blank on more than one element - note, setting configuration scim.skipTypeConvert=true will disable this logic/check`)
                      }
                      tmpAddr.push(i)
                    }
                  }
                } else {
                  err = new Error(`'type converted object' ${key} - includes more than one element having same type, or type is blank on more than one element - note, setting configuration scim.skipTypeConvert=true will disable this logic/check`)
                }
              }
              newMulti[key][element.type] = {}
              for (const i in element) {
                newMulti[key][element.type][i] = element[i]
              }
            }
          })
          delete scimdata[key]
        }
      }
    }
    if (scimdata.active && typeof scimdata.active === 'string') {
      const lcase = scimdata.active.toLowerCase()
      if (lcase === 'true') scimdata.active = true
      else if (lcase === 'false') scimdata.active = false
    }
    if (scimdata.meta) { // cleared attributes e.g { meta: { attributes: [ 'name.givenName', 'title' ] } }
      if (Array.isArray(scimdata.meta.attributes)) {
        scimdata.meta.attributes.forEach(el => {
          let rootKey
          let subKey
          if (el.startsWith('urn:')) { // can't use dot.str on key having dot e.g. urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department
            const i = el.lastIndexOf(':')
            subKey = el.substring(i + 1)
            if (subKey === 'User' || subKey === 'Group') rootKey = el
            else rootKey = el.substring(0, i)
          }
          if (rootKey) {
            if (!scimdata[rootKey]) scimdata[rootKey] = {}
            dot.str(subKey, '', scimdata[rootKey])
          } else {
            dot.str(el, '', scimdata)
          }
        })
      }
      delete scimdata.meta
    }
    for (const key in newMulti) {
      dot.copy(key, key, newMulti, scimdata)
    }
    return [scimdata, err]
  }
} // scimgateway

//
// exported methods
//
ScimGateway.prototype.countries = countries

ScimGateway.prototype.getPassword = (pwEntity, configFile) => {
  return utils.getPassword(pwEntity, configFile) // utils.getPassword('scimgateway.password', './config/plugin-testmode.json');
}

ScimGateway.prototype.formatError = (action, err) => {
  throw  new Error(`${action} error: ${err.message}`);
}

ScimGateway.prototype.timestamp = () => {
  return utils.timestamp()
}

ScimGateway.prototype.copyObj = (o) => {
  return utils.copyObj(o)
}

ScimGateway.prototype.extendObj = (obj, src) => {
  return utils.extendObj(obj, src)
}

ScimGateway.prototype.Lock = utils.Lock

ScimGateway.prototype.getArrayObject = (Obj, element, type) => {
  if (Obj[element]) { // element is case sensitive
    return Obj[element].find(function (el) {
      return (el.type && (el.type).toLowerCase() === type.toLowerCase())
    })
  }
  return null
}

/*
ScimGateway.prototype.isMultiValueTypes = function isMultiValueTypes (attr) { // emails
  return multiValueTypes.includes(attr)
}
*/

//
// getMultivalueTypes returns an array of mulitvalue attributes allowing type e.g [emails,addresses,...]
// objName should be 'User' or 'Group'
//
const getMultivalueTypes = (objName, scimDef) => { // objName = 'User' or 'Group'
  if (!objName) return []

  const obj = scimDef.Schemas.Resources.find(el => {
    return (el.name === objName)
  })
  if (!obj) return []

  return obj.attributes
    .filter(el => {
      return (el.multiValued === true && el.subAttributes &&
        el.subAttributes
          .find(function (subel) {
            return (subel.name === 'type')
          })
      )
    })
    .map(obj => obj.name)
}

// config can be set based on environment variables
// config can be set based on correspondig json-content in external file (supports also dot notation)
// syntax environment = "process.env.<ENVIRONMENT>" e.g. config.port could have value "process.env.PORT", then using environment variable PORT
// syntax file = "process.file.<PATH>" e.g. config.password could have value "process.file./tmp/myconf.json"
ScimGateway.prototype.processExtConfig = function processExtConfig (pluginName, config, isMain) {
  const processEnv = 'process.env.'
  const processFile = 'process.file.'
  const processText = 'process.text.'
  const dotConfig = dot.dot(config)
  const processTexts = new Map()
  const processFiles = new Map()

  for (const key in dotConfig) {
    let value = dotConfig[key]
    if (value && value.constructor === String && value.includes(processEnv)) {
      const envKey = value.substring(processEnv.length)
      value = process.env[envKey]
      dotConfig[key] = value
      if (!value) {
        const newErr = new Error(`configuration failed - can't use none existing environment: "${envKey}"`)
        newErr.name = 'processExtConfig'
        throw newErr
      }
    } else if (value && value.constructor === String && value.includes(processText)) {
      const filePath = value.substring(processText.length)
      try {
        if (!processTexts.has(filePath)) { // avoid reading previous file
          processTexts.set(filePath, fs.readFileSync(filePath, 'utf8'))
        }
        value = processTexts.get(filePath) // directly a string
      } catch (err) {
        value = undefined
        throw new Error(`configuration failed - can't read text from external file: "${filePath}"`)
      }
      dotConfig[key] = value
    } else if (value && value.constructor === String && value.includes(processFile)) {
      const filePath = value.substring(processFile.length)
      try {
        if (!processFiles.has(filePath)) { // avoid reading previous file
          processFiles.set(filePath, JSON.parse(fs.readFileSync(filePath, 'utf8')))
        }
        try {
          const jContent = processFiles.get(filePath) // json or json-dot-notation formatting is supported
          const dotContent = dot.dot(dot.object(jContent))
          let newKey = null
          if (isMain) newKey = `${pluginName}.scimgateway.${key}`
          else newKey = `${pluginName}.endpoint.${key}`
          value = dotContent[newKey]
          if (value === undefined) {
            if (dotContent[newKey + '.0']) { // check if array
              let i = 0
              do {
                dotConfig[key + '.' + i] = dotContent[newKey + '.' + i]
                i += 1
              } while (dotContent[newKey + '.' + i])
            } else {
              const newErr = new Error(`configuration failed - external JSON file "${filePath}" does not contain key: "${newKey}"`)
              newErr.name = 'processExtConfig'
              throw newErr
            }
          }
        } catch (err) {
          if (err.name && err.name === 'processExtConfig') throw err
          else {
            const newErr = new Error(`configuration failed - can't JSON parse external file: "${filePath}"`)
            newErr.name = 'processExtConfig'
            throw newErr
          }
        }
      } catch (err) {
        value = undefined
        if (err.name && err.name === 'processExtConfig') throw err
        else throw (new Error(`configuration failed - can't read external configuration file: ${err.message}`))
      }
      dotConfig[key] = value
    }
  }
  processTexts.clear()
  processFiles.clear()
  return dot.object(dotConfig)
}

// SCIM/CustomScim <=> endpoint attribute parsing used by plugins
// returns [object/string, err]
// TO-DO: rewrite and simplify...
ScimGateway.prototype.endpointMapper = async function endpointMapper (direction, parseObj, mapObj) {
  const dotMap = dot.dot(mapObj)
  let str = ''
  let isObj = false
  let noneCore = false
  const arrUnsupported = []
  const inboundArrCheck = []
  const complexArr = []
  const complexObj = {
    addresses: {},
    emails: {},
    phoneNumbers: {},
    entitlements: {},
    ims: {},
    photos: {}
    // roles: {} using array
  }
  let dotParse = null
  const dotNewObj = {}

  if (parseObj.constructor === String || parseObj.constructor === Array) str = parseObj // parseObj is attributes list e.g. 'userName,id' or ['userName', 'id']
  else {
    isObj = true
    if (parseObj['@odata.context']) delete parseObj['@odata.context'] // AAD cleanup  
    if (parseObj.controls) delete parseObj.controls // Active Directory cleanup
    dotParse = dot.dot(parseObj) // {"name": {"givenName": "myName"}} => {"name.givenName": "myName"}

    // deletion of complex entry => set to blank
    const arrDelete = []
    for (const key in dotParse) {
      if (key.endsWith('.operation')) {
        const arr = key.split('.') // addresses.work.operation
        if (arr.length > 2 && complexObj[arr[0]] && dotParse[key] === 'delete') {
          arrDelete.push(`${arr[0]}.${arr[1]}.`) // addresses.work.
          delete dotParse[key]
        }
      }
    }
    for (let i = 0; i < arrDelete.length; i++) {
      for (const key in dotParse) {
        if (key.startsWith(arrDelete[i])) dotParse[key] = '' // Active Directory: if country included, no logic on country codes cleanup - c (shortname) and countryCode
      }
    }
  }

  switch (direction) {
    case 'outbound':
      for(const mapKey in mapObj){
        // formatting mapping variables
        if(mapObj[mapKey].type === 'dateTime' && parseObj[mapObj[mapKey].mapTo]){
          dotParse[mapObj[mapKey].mapTo] = new Date(parseObj[mapObj[mapKey].mapTo])
        }
        
        let deafultValue = mapObj[mapKey].default
        if(![undefined, null, ""].includes(deafultValue)){           
          let expression = jsonata(deafultValue);
          let result = await expression.evaluate(parseObj) || '';
          if(result.toString().trim().length && !dotParse[mapObj[mapKey].mapTo]) {
            dotParse[mapObj[mapKey].mapTo] = result
          }
        }
      }
      if (isObj) { // body (patch/put)
        for (let key in dotParse) {
          let found = false
          let arrIndex = null
          const arr = key.split('.') // multivalue/array - servicePlan.0.value
          const keyOrg = key
          if (arr[arr.length - 1] === 'value') {
            if (!isNaN(arr[arr.length - 2])) { // servicePlan.0.value => servicePlan.0
              for (let i = 0; i < (arr.length - 2); i++) {
                if (i === 0) key = arr[i]
                else key += `.${arr[i]}`
              }
              arrIndex = arr[arr.length - 2]
            } else if (arr[arr.length - 2].slice(-1) === ']' && arr.length - 2 === 0) { // groups[0].value => groups.value
              const startPos = arr[0].indexOf('[')
              if (startPos > 0) {
                key = arr[0].substring(0, startPos) + '.value' // groups.value
                arrIndex = arr[0].substring(startPos + 1, arr[0].length - 1) // 1
              }
            }
          }
          for (const key2 in dotMap) {
            if (!key2.endsWith('.mapTo')) continue
            if (dotMap[key2].split(',').map(item => item.trim().toLowerCase()).includes(key.toLowerCase())) {
              found = true
              const keyRoot = key2.split('.').slice(0, -1).join('.') // xx.yy.mapTo => xx.yy
              if (dotMap[`${keyRoot}.type`] === 'array' && arrIndex && arrIndex >= 0) {
                dotNewObj[`${keyRoot}.${arrIndex}`] = dotParse[keyOrg] // servicePlan.0.value => servicePlan.0 and groups[0].value => memberOf.0
              }
              dotNewObj[keyRoot] = dotParse[key] // {"accountEnabled": {"mapTo": "active"} => str.replace("accountEnabled", "active")
              break
            }
          }
          if (!found) arrUnsupported.push(key)
        }
      } else { // string (get)
        const resArr = []
        let strArr = []
        if (Array.isArray(str)) {
          for (let i = 0; i < str.length; i++) {
            strArr = strArr.concat(str[i].split(',').map(item => item.trim())) // supports "id,userName" e.g. {"mapTo": "id,userName"}
          }
        } else strArr = str.split(',').map(item => item.trim())
        for (let i = 0; i < strArr.length; i++) {
          const attr = strArr[i]
          let found = false
          for (const key in dotMap) {
            if (!key.endsWith('.mapTo')) continue
            const keyNotDot = key.substring(0, key.indexOf('.mapTo'))
            if (dotMap[key].split(',').map(item => item.trim()).includes(attr)) { // supports { "mapTo": "userName,id" }
              found = true
              if (!resArr.includes(keyNotDot)) resArr.push(keyNotDot)
              break
            } else if (attr === 'roles' && dotMap[key] === 'roles.value') { // allow get using attribute roles - convert to correct roles.value
              found = true
              resArr.push(keyNotDot)
              break
            } else {
              if (dotMap[key].startsWith(attr + '.')) { // e.g. emails - complex definition
                if (complexObj[attr]) {
                  found = true
                  resArr.push(keyNotDot)
                // don't break - check for multiple complex definitions
                }
              }
            }
          }
          if (!found) {
            arrUnsupported.push(attr) // comment out? - let caller decide if not to handle unsupported on GET requests (string)
          }
        }
        if (Array.isArray(str)) str = resArr
        else str = resArr.toString()
      }
      break

    case 'inbound':
      for (let key in dotParse) {
        if (Array.isArray(dotParse[key]) && dotParse[key].length < 1) continue // avoid including 'value' in empty array if mapTo xx.value

        if (key.startsWith('lastLogon') && !isNaN(dotParse[key])) { // Active Directory date convert e.g. 132340394347050132 => "2020-05-15 20:03:54"
          const ll = new Date(parseInt(dotParse[key], 10) / 10000 - 11644473600000)
          dotParse[key] = ll.getFullYear() + '-' +
            ('00' + (ll.getMonth() + 1)).slice(-2) + '-' +
            ('00' + ll.getDate()).slice(-2) + ' ' +
            ('00' + (ll.getHours())).slice(-2) + ':' +
            ('00' + ll.getMinutes()).slice(-2) + ':' +
            ('00' + ll.getSeconds()).slice(-2)
        }

        // first element array gives xxx[0] instead of xxx.0
        let keyArr = key.split('.')
        if (keyArr[0].slice(-1) === ']') { // last character=]
          let newStr = keyArr[0]
          newStr = newStr.replace('[', '.')
          newStr = newStr.replace(']', '') // member[0] => member.0
          dotParse[newStr] = dotParse[key]
          key = newStr // will be handled below
        }

        let dotArrIndex = null
        keyArr = key.split('.')
        if (keyArr.length > 1 && !isNaN(keyArr[1])) { // array
          key = keyArr[0] // "proxyAddresses.0" => "proxyAddresses"
          dotArrIndex = keyArr[1]
        }

        if (!dotMap[`${key}.mapTo`]) continue

        if (dotMap[`${key}.type`] === 'array') {
          let newStr = dotMap[`${key}.mapTo`]
          if (newStr === 'roles') { // {"mapTo": "roles"} should be {"mapTo": "roles.value"}
            arrUnsupported.push('roles.value')
          }
          let multiValue = true
          if (newStr.indexOf('.value') > 0) newStr = newStr.substring(0, newStr.indexOf('.value')) // multivalue back to ScimGateway - remove .value if defined
          else multiValue = false
          if (dotArrIndex !== null) { // array e.g proxyAddresses.value mapTo proxyAddresses converts proxyAddresses.0 => proxyAddresses.0.value
            if (multiValue) dotNewObj[`${newStr}.${dotArrIndex}.value`] = dotParse[`${key}.${dotArrIndex}`]
            else {
              if (dotMap[`${key}.typeInbound`] && dotMap[`${key}.typeInbound`] === 'string') {
                if (!dotNewObj[newStr]) dotNewObj[newStr] = dotParse[`${key}.${dotArrIndex}`]
                else dotNewObj[newStr] = `${dotNewObj[newStr]}, ${dotParse[`${key}.${dotArrIndex}`]}`
              } else dotNewObj[`${newStr}.${dotArrIndex}`] = dotParse[`${key}.${dotArrIndex}`]
            }
          } else { // type=array but element is not array
            if (multiValue) dotNewObj[`${newStr}.0.value`] = dotParse[key]
            else dotNewObj[newStr] = dotParse[key]
            if (!inboundArrCheck.includes(newStr)) inboundArrCheck.push(newStr) // will be checked
          }
        } else { // none array
          // let mapTo = mapObj[key].mapTo
          let mapTo = dotMap[`${key}.mapTo`]
          if (mapTo.startsWith('urn:')) { // dot workaround for none core (e.g. enterprise and custom schema attributes) having dot in key e.g "2.0": urn:ietf:params:scim:schemas:extension:enterprise:2.0:User.department
            mapTo = mapTo.replace('.', '##') // only first occurence
            noneCore = true
          }
          const arrMapTo = mapTo.split(',').map(item => item.trim()) // supports {"mapTo": "id,userName"}
          for (let i = 0; i < arrMapTo.length; i++) {
            dotNewObj[arrMapTo[i]] = dotParse[key] // {"active": {"mapTo": "accountEnabled"} => str.replace("accountEnabled", "active")
          }
        }
        // let mapTo = mapObj[key].mapTo
        let mapTo = dotMap[`${key}.mapTo`]
        if (mapTo.startsWith('urn:')) {
          mapTo = mapTo.replace('.', '##')
          noneCore = true
        }
        const arr = mapTo.split('.') // addresses.work.postalCode
        if (arr.length > 2 && complexObj[arr[0]]) complexArr.push(arr[0]) // addresses
      }
      break

    default:
      this.logger.error('Plugin using endpointMapper(direction, parseObj, mapObj) with incorrect direction - direction must be set to \'outbound\' or \'inbound\'')
      str = parseObj
  }

  // error handling (only outbound, not inbound)
  let err = null
  const arrErr = []
  for (let i = 0; i < arrUnsupported.length; i++) {
    const arr = arrUnsupported[i].split('.')
    if (arr.length > 2 && complexObj[arr[0]]) continue // no error on complex
    else if (arr.length === 2 && arr[0].startsWith('roles')) {
      if (arr[1] === 'operation') err = new Error('endpointMapper: roles cannot include operation - telling to be deleted - roles needs proper preprocessing when used by endpointMapper')
      else if (arr[1] !== 'value') continue // no error on roles.display, roles.primary
    }
    arrErr.push(arrUnsupported[i])
  }
  if (!err && arrErr.length > 0) {
    err = new Error(`endpointMapper: skipping - no mapping found for attributes: ${arrErr.toString()}`)
  }

  if (isObj) {
    let newObj = dot.object(dotNewObj) // from dot to normal

    if (noneCore) { // revert back dot workaround
      const tmpObj = {}
      for (const key in newObj) {
        if (key.includes('##')) {
          const newKey = key.replace('##', '.')
          tmpObj[newKey] = newObj[key]
        } else tmpObj[key] = newObj[key]
      }
      newObj = tmpObj
    }

    if (arrUnsupported.length > 0) { // delete from newObj when not included in map
      for (const i in arrUnsupported) {
        const arr = arrUnsupported[i].split('.') // emails.work.type
        dot.delete(arrUnsupported[i], newObj) // delete leaf
        for (let i = arr.length - 2; i > -1; i--) { // delete above if not empty
          let oStr = arr[0]
          for (let j = 1; j <= i; j++) {
            oStr += `.${arr[j]}`
          }
          const sub = dot.pick(oStr, newObj)
          if (!sub || JSON.stringify(sub) === '{}') {
            dot.delete(oStr, newObj)
          }
        }
      }
    }

    const recursiveStrMap = function (obj, dotPath) { // converts inbound/outbound regarding endpointMap type of attribute
      for (const key in obj) {
        if (obj[key] && obj[key].constructor === Object) recursiveStrMap(obj[key], (dotPath ? `${dotPath}.${key}` : key))
        let dotKey = ''
        if (!dotPath) dotKey = key
        else dotKey = `${dotPath}.${key}`
        if (direction === 'outbound') { // outbound
          if (obj[key] === '') obj[key] = null
          if (dotMap[`${dotKey}.type`]) {
            const type = dotMap[`${dotKey}.type`].toLowerCase()
            if (type === 'boolean' && obj[key].constructor === String) {
              if ((obj[key]).toLowerCase() === 'true') obj[key] = true
              else if ((obj[key]).toLowerCase() === 'false') obj[key] = false
            } else if (type === 'array') {
              if (!Array.isArray(obj[key])) {
                if (!obj[key]) obj[key] = []
                else obj[key] = [obj[key]]
              }
            } else if (dotMap.sAMAccountName) { // Active Directory
              if (dotMap[`${dotKey}.mapTo`].startsWith('addresses.') && dotMap[`${dotKey}.mapTo`].endsWith('.country')) {
                const arr = countries.codes.filter(el => obj[key] && el.name === obj[key].toUpperCase())
                if (arr.length === 1) { // country name found in countries, include corresponding c (shortname) and countryCode
                  obj.c = arr[0]['alpha-2']
                  obj.countryCode = arr[0]['country-code']
                }
              }
            }
          }
        } else { // inbound - convert all values to string unless array or boolean
          if (obj[key] === null) delete obj[key] // or set to ''
          else if (obj[key] || obj[key] === false) {
            if (key === 'id') {
              obj[key] = encodeURIComponent(obj[key]) // escaping in case idp don't e.g. Symantec/Broadcom/CA
            }
            if (Array.isArray(obj[key])) { // array
              if (key === 'members' || key === 'groups') {
                for (const el in obj[key]) {
                  if (obj[key][el].value) {
                    obj[key][el].value = encodeURIComponent(obj[key][el].value) // escaping values because id have also been escaped
                  }
                }
              }
            } else if (obj[key].constructor !== Object) {
              if (obj[key].constructor !== Boolean) obj[key] = obj[key].toString() // might have integer that also should be SCIM integer?
            }
          }
        }
      }
    }

    recursiveStrMap(newObj, null)

    if (direction === 'inbound' && newObj.constructor === Object) { // convert any multivalue object syntax to array
      //
      // map config e.g.:
      // "postalCode": {
      //  "mapTo": "addresses.work.postalCode",
      //  "type": "string"
      // }
      //
      if (complexArr.length > 0) {
        const tmpObj = {}
        for (let i = 0; i < complexArr.length; i++) { // e.g. ['emails', 'addresses', 'phoneNumbers', 'ims', 'photos']
          const el = complexArr[i]
          if (newObj[el]) { // { work: { postalCode: '1733' }, work: { streetAddress: 'Roteveien 10' } }
            const tmp = {}
            for (const key in newObj[el]) {
              if (newObj[el][key].constructor === Object) { // { postalCode: '1733' }
                if (!tmp[key]) tmp[key] = [{ type: key }]
                const o = tmp[key][0]
                for (const k in newObj[el][key]) { // merge into one object
                  o[k] = newObj[el][key][k]
                }
                tmp[key][0] = o // { addresses: [ { type: 'work', postalCode: '1733', streetAddress: 'Roteveien 10'} ] } - !isNaN because of push
              }
            }
            delete newObj[el]
            tmpObj[el] = []
            for (const key in tmp) {
              tmpObj[el].push(tmp[key][0])
            }
          }
        }
        utils.extendObj(newObj, tmpObj)
      }

      // make sure inboundArrCheck elements are array
      // e.g. AD group "member" could be string if one, and array if more than one
      for (const i in inboundArrCheck) {
        const el = inboundArrCheck[i]
        if (newObj[el] && !Array.isArray(newObj[el])) {
          newObj[el] = [newObj[el]]
        }
      }
    }

    return [newObj, err]
  } else return [str, err]
}

module.exports = ScimGateway // plugins can now use ScimGateway

const addResources = (data, startIndex, sortBy, sortOrder) => {
  if (!data || JSON.stringify(data) === '{}') data = [] // no user/group found
  const res = { Resources: [] }
  if (Array.isArray(data)) res.Resources = data
  else if (data.Resources) {
    res.Resources = data.Resources
    res.totalResults = data.totalResults
  } else res.Resources.push(data)

  // pagination
  if (!res.totalResults) res.totalResults = res.Resources.length // Specifies the total number of results matching the Consumer query
  res.itemsPerPage = res.Resources.length // Specifies the number of search results returned in a query response page
  res.startIndex = parseInt(startIndex) // The 1-based index of the first result in the current set of search results
  if (!res.startIndex) res.startIndex = 1
  if (res.startIndex > res.totalResults) { // invalid paging request
    res.Resources = []
    res.itemsPerPage = 0
  }

  if (sortBy) res.Resources.sort(utils.sortByKey(sortBy, sortOrder))
  return res
}

const addSchemas = (data, type, isScimv2, location) => {
  if (!type) {
    if (isScimv2) data.schemas = ['urn:ietf:params:scim:api:messages:2.0:ListResponse']
    else data.schemas = ['urn:scim:schemas:core:1.0']
    return data
  }

  if (data.Resources) {
    if (isScimv2) data.schemas = ['urn:ietf:params:scim:api:messages:2.0:ListResponse']
    else data.schemas = ['urn:scim:schemas:core:1.0']
    for (let i = 0; i < data.Resources.length; i++) {
      if (isScimv2) { // scim v2 add schemas/resourceType on each element
        if (type === 'User') {
          const val = 'urn:ietf:params:scim:schemas:core:2.0:User'
          if (!data.Resources[i].schemas) data.Resources[i].schemas = [val]
          else if (!data.Resources[i].schemas.includes(val)) data.Resources[i].schemas.push(val)
          if (!data.Resources[i].meta) data.Resources[i].meta = {}
          data.Resources[i].meta.resourceType = type
          if (location && data.Resources[i].id) data.Resources[i].meta.location = `${location}/${data.Resources[i].id}`
        } else if (type === 'Group') {
          const val = 'urn:ietf:params:scim:schemas:core:2.0:Group'
          if (!data.Resources[i].schemas) data.Resources[i].schemas = [val]
          else if (!data.Resources[i].schemas.includes(val)) data.Resources[i].schemas.push(val)
          if (!data.Resources[i].meta) data.Resources[i].meta = {}
          data.Resources[i].meta.resourceType = 'Group'
        }
      }
      if (location && data.Resources[i].id) {
        if (!data.Resources[i].meta) data.Resources[i].meta = {}
        data.Resources[i].meta.location = `${location}/${data.Resources[i].id}`
      }
      for (const key in data.Resources[i]) {
        if (key.startsWith('urn:')) {
          if (key.includes(':1.0')) {
            if (!data.schemas) data.schemas = []
            if (!data.schemas.includes(key)) data.schemas.push(key)
          } else { // scim v2 add none core schemas on each element
            if (!data.Resources[i].schemas) data.Resources[i].schemas = []
            if (!data.Resources[i].schemas.includes(key)) data.Resources[i].schemas.push(key)
          }
        } else if (key === 'password') delete data.Resources[i].password // exclude password, null and empty object/array
        else if (data.Resources[i][key] === null) delete data.Resources[i][key]
        else if (JSON.stringify(data.Resources[i][key]) === '{}') delete data.Resources[i][key]
        else if (Array.isArray(data.Resources[i][key]) && data.Resources[i][key].length < 1) delete data.Resources[i][key]
      }
      if (Object.keys(data.Resources[i]).length === 0) {
        data.Resources.splice(i, 1) // delete
        i -= 1
      }
    }
  } else {
    if (isScimv2) {
      if (type === 'User') {
        const val = 'urn:ietf:params:scim:schemas:core:2.0:User'
        if (!data.schemas) data.schemas = [val]
        else if (!data.schemas.includes(val)) data.schemas.push(val)
        if (!data.meta) data.meta = {}
        data.meta.resourceType = type
      } else if (type === 'Group') {
        const val = 'urn:ietf:params:scim:schemas:core:2.0:Group'
        if (!data.schemas) data.schemas = [val]
        else if (!data.schemas.includes(val)) data.schemas.push(val)
        if (!data.meta) data.meta = {}
        data.meta.resourceType = type
      }
    } else {
      const val = 'urn:scim:schemas:core:1.0'
      if (!data.schemas) data.schemas = [val]
      else if (!data.schemas.includes(val)) data.schemas.push(val)
    }
    for (const key in data) {
      if (key.startsWith('urn:')) { // add none core schema e.g. urn:ietf:params:scim:schemas:extension:enterprise:2.0:User
        if (!data.schemas) data.schemas = [key]
        else if (!data.schemas.includes(key)) data.schemas.push(key)
      } else if (key === 'password') delete data.password // exclude password, null and empty object/array
      else if (data[key] === null) delete data[key]
      else if (JSON.stringify(data[key]) === '{}') delete data[key]
      else if (Array.isArray(data[key]) && data[key].length < 1) delete data[key]
    }
  }

  return data
}

// addPrimaryAttrs cheks for primary attributes (only for roles) and add them as standalone attributes
// some IdP's may check for these e.g. Azure
// e.g. {roles: [{value: "val1", primary: "True"}]}
// gives:
// { roles: [{value: "val1", primary: "True"}],
//   roles[primary eq "True"].value: "val1",
//   roles[primary eq "True"].primary: "True"}]
// }
const addPrimaryAttrs = (obj) => {
  const key = 'roles'
  if (!obj || typeof obj !== 'object') return obj
  if (!obj[key] || !Array.isArray(obj[key])) return obj
  const o = utils.copyObj(obj)
  const index = o[key].findIndex(el => (el.primary === true || (typeof el.primary === 'string' && el.primary.toLowerCase() === 'true')))
  if (index >= 0) {
    const prim = o[key][index]
    for (const k in prim) {
      const primKey = `${key}[primary eq ${typeof prim.primary === 'string' ? `"${prim.primary}"` : prim.primary}].${k}` // roles[primary eq true].value / roles[primary eq "True"].value``
      o[primKey] = prim[k] // { roles[primary eq true].value : "some-value" }
    }
  }
  return o
}

//
// Check and return none supported attributes
//
const notValidAttributes = (obj, validScimAttr) => {
  if (validScimAttr.length < 1) return ''
  const tgt = dot.dot(obj)
  const ret = (Object.keys(tgt).filter(function (key) { // {'name.givenName': 'Jarle', emails.0.type': 'work'}
    const arrKey = key.split('.')
    if (arrKey.length > 2) key = `${arrKey[0]}.${arrKey[1]}` // e.g emails.work.value => emails.work
    if (key.indexOf('meta.attributes') === 0 || key.indexOf('schemas.') === 0) return false // attributes to be cleard or schema not needed in validScimAttr
    else return (validScimAttr.indexOf(key) === -1)
  }))
  if (ret.length > 0) return ret
  else return null
}

//
// convertedScim20 convert SCIM 2.0 patch request to SCIM 1.1 and calls convertedScim() for "type converted Object" and blank deleted values
//
// Scim 2.0:
// {"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"Replace","path":"name.givenName","value":"Rocky"},{"op":"Remove","path":"name.formatted","value":"Rocky Balboa"},{"op":"Add","path":"emails","value":[{"value":"user@compay.com","type":"work"}]}]}
//
// Scim 1.1
// {"name":{"givenName":"Rocky","formatted":"Rocky Balboa"},"meta":{"attributes":["name.formatted"]},"emails":[{"value":"user@compay.com","type":"work"}]}
//
// "type converted object" and blank deleted values
// {"name":{"givenName":"Rocky",formatted:""},"emails":{"work":{"value":"user@company.com","type":"work"}}}
//
ScimGateway.prototype.convertedScim20 = function convertedScim20 (obj) {
  let scimdata = {}
  if (!obj.Operations || !Array.isArray(obj.Operations)) return scimdata
  const o = utils.copyObj(obj)
  const arrPrimaryDone = []
  const primaryOrgType = {}

  for (let i = 0; i < o.Operations.length; i++) {
    const element = o.Operations[i]
    let type = null
    let typeElement = null
    let path = null
    let pathRoot = null
    let rePattern = /^.*\[(.*) eq (.*)\].*$/
    let arrMatches = null
    let primaryValue = null

    if (element.op) element.op = element.op.toLowerCase()

    if (element.path) {
      arrMatches = element.path.match(rePattern)

      if (Array.isArray(arrMatches) && arrMatches.length === 3) { // [type eq "work"]
        if (arrMatches[1] === 'primary') {
          type = 'primary'
          primaryValue = arrMatches[2].replace(/"/g, '') // True
        } else type = arrMatches[2].replace(/"/g, '') // work
      }

      rePattern = /^(.*)\[(type|primary) eq .*\]\.(.*)$/ // "path":"addresses[type eq \"work\"].streetAddress" - "path":"roles[primary eq \"True\"].streetAddress"
      arrMatches = element.path.match(rePattern)
      if (Array.isArray(arrMatches)) {
        if (arrMatches.length === 2) {
          if (type) path = `${arrMatches[1]}.${type}`
          else path = arrMatches[1]
          pathRoot = arrMatches[1]
        } else if (arrMatches.length === 4) {
          if (type) {
            path = `${arrMatches[1]}.${type}.${arrMatches[3]}`
            typeElement = arrMatches[3] // streetAddress

            if (type === 'primary' && !arrPrimaryDone.includes(arrMatches[1])) { // make sure primary is included
              const pObj = utils.copyObj(element)
              pObj.path = pObj.path.substring(0, pObj.path.lastIndexOf('.')) + '.primary'
              pObj.value = primaryValue
              o.Operations.push(pObj)
              arrPrimaryDone.push(arrMatches[1])
              primaryOrgType[arrMatches[1]] = 'primary'
            }
          } else path = `${arrMatches[1]}.${arrMatches[3]}` // NA
          pathRoot = arrMatches[1]
        }
      } else {
        rePattern = /^(.*)\[type eq .*\]$/ // "path":"addresses[type eq \"work\"]"
        arrMatches = element.path.match(rePattern)
        if (Array.isArray(arrMatches) && arrMatches.length === 2) {
          if (type) path = `${arrMatches[1]}.${type}`
          else path = arrMatches[1]
          pathRoot = arrMatches[1]
        }
      }

      rePattern = /^(.*)\[value eq (.*)\]$/ // "path":"members[value eq \"bjensen\"]"
      arrMatches = element.path.match(rePattern)
      if (Array.isArray(arrMatches) && arrMatches.length === 3) {
        // eslint-disable-next-line no-unused-vars
        path = arrMatches[1]
        pathRoot = arrMatches[1]
        const val = arrMatches[2].replace(/"/g, '') // "bjensen" => bjensen
        element.value = val
        typeElement = 'value'
      }

      if (element.value && Array.isArray(element.value)) {
        element.value.forEach(function (el, i) { // {"value": [{ "value": "jsmith" }]}
          if (el.value) {
            if (typeof el.value === 'object') { // "value": [{"value": {"id":"c20e145e-5459-4a6c-a074-b942bbd4cfe1","value":"admin","displayName":"Administrator"}}]
              element.value[i] = el.value
            } else if (typeof el.value === 'string' && el.value.substring(0, 1) === '{') { // "value": [{"value":"{\"id\":\"c20e145e-5459-4a6c-a074-b942bbd4cfe1\",\"value\":\"admin\",\"displayName\":\"Administrator\"}"}}]
              try {
                element.value[i] = JSON.parse(el.value)
              } catch (err) {}
            }
          }
        })
      }

      if (element.value && element.value.value && typeof element.value.value === 'string') { // "value": { "value": "new_email@testing.org" }
        const el = {}
        el.value = element.value.value
        if (element.op && element.op === 'remove') el.operation = 'delete'
        element.value = []
        element.value.push(el)
      }

      if (pathRoot) { // pathRoot = emails and path = emails.work.value (we may also have path = pathRoot)
        if (!scimdata[pathRoot]) scimdata[pathRoot] = []
        const index = scimdata[pathRoot].findIndex(el => el.type === type)
        if (index < 0) {
          if (typeof element.value === 'object') { // e.g. addresses with no typeElement - value includes object having all attributes
            if (element.op && element.op === 'remove') element.value.operation = 'delete'
            scimdata[pathRoot].push(element.value)
          } else {
            const el = {}
            if (element.op && element.op === 'remove') el.operation = 'delete'
            if (type) el.type = type // members no type
            if (element.value) el[typeElement] = element.value // {"value": "some-value"} or {"steetAddress": "some-address"}
            scimdata[pathRoot].push(el)
          }
        } else {
          if (typeElement === 'value' && scimdata[pathRoot][index].value) { // type exist for value index => duplicate type => push new - duplicates handled by last step confertedScim() if needed
            const el = {}
            if (element.op && element.op === 'remove') el.operation = 'delete'
            if (type) el.type = type
            el[typeElement] = element.value
            scimdata[pathRoot].push(el)
          } else {
            if (type === 'primary' && typeElement === 'type') { // type=primary, don't change but store and correct to original type later
              primaryOrgType[pathRoot] = element.value
            } else scimdata[pathRoot][index][typeElement] = element.value
            if (element.op && element.op === 'remove') scimdata[pathRoot][index].operation = 'delete'
          }
        }
      } else { // use element.path e.g name.familyName and members
        if (Array.isArray(element.value)) {
          for (let i = 0; i < element.value.length; i++) {
            if (!scimdata[element.path]) scimdata[element.path] = []
            if (element.op && element.op === 'remove') {
              if (typeof element.value[i] === 'object') element.value[i].operation = 'delete'
            }
            scimdata[element.path].push(element.value[i])
          }
        } else { // add to operations loop without path => handled by "no path"
          const obj = {}
          obj.op = element.op
          obj.value = {}
          obj.value[element.path] = element.value
          o.Operations.push(obj)
        }
      }
    } else { // no path
      for (const key in element.value) {
        if (Array.isArray(element.value[key])) {
          element.value[key].forEach(function (el, i) {
            if (element.op && element.op === 'remove') el.operation = 'delete'
            if (!scimdata[key]) scimdata[key] = []
            scimdata[key].push(el)
          })
        } else {
          let value = element.value[key]
          if (element.op && element.op === 'remove') {
            if (!scimdata.meta) scimdata.meta = {}
            if (!scimdata.meta.attributes) scimdata.meta.attributes = []
            scimdata.meta.attributes.push(key)
          }
          if (key.startsWith('urn:')) { // can't use dot.str on key having dot e.g. urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department
            const i = key.lastIndexOf(':')
            let k = key.substring(i + 1) // User, Group or <parentAttribute>.<childAttribute> - <URN>:<parentAttribute>.<childAttribute> e.g. :User:manager.value
            let rootKey
            if (k === 'User' || k === 'Group') rootKey = key
            else rootKey = key.substring(0, i) // urn:ietf:params:scim:schemas:extension:enterprise:2.0:User
            if (k === 'User' || k === 'Group') { // value is object
              const o = {}
              o[rootKey] = value
              scimdata = utils.extendObj(scimdata, o)
            } else {
              if (!scimdata[rootKey]) scimdata[rootKey] = {}
              if (k === 'manager' && typeof value !== 'object') { // fix Azure bug sending manager instead of manager.value
                k = 'manager.value'
              }
              if (!element.op || element.op !== 'remove') { // remove handled by general logic above
                dot.str(k, value, scimdata[rootKey])
              }
            }
          } else {
            if (typeof value === 'object') {
              for (const k in element.value[key]) {
                if (element.op && element.op === 'remove') {
                  if (!scimdata.meta) scimdata.meta = {}
                  if (!scimdata.meta.attributes) scimdata.meta.attributes = []
                  scimdata.meta.attributes.push(`${key}.${k}`)
                } else {
                  value = element.value[key][k]
                  dot.str(`${key}.${k}`, value, scimdata)
                }
              }
            } else dot.str(key, value, scimdata)
          }
        }
      }
    }
  }

  for (const key in primaryOrgType) { // revert back to original type when included
    if (scimdata[key]) {
      const index = scimdata[key].findIndex(el => el.type === 'primary')
      if (index >= 0) {
        if (primaryOrgType[key] === 'primary') delete scimdata[key][index].type // temp have not been changed - remove
        else scimdata[key][index].type = primaryOrgType[key]
      }
    }
  }
  
  if(scimdata.members){
    scimdata.members = scimdata.members.map((item) => {
      item.operation = item.operation || 'add'

      return item
    })
  }

  // scimdata now SCIM 1.1 formatted, using convertedScim to get "type converted Object" and blank deleted values
  return ScimGateway.prototype.convertedScim(scimdata)
}

//
// clearObjectValues returns a new object having values set to blank
// array values are kept, but includes {"operation" : "delete"} - scim 1.1 formatted
// boolean values e.g. {"active" : true} are kept "as is"
// parent used for internal recursive logic
const clearObjectValues = (o, parent) => {
  if (!o) return {}
  let v, key
  const output = Object.getPrototypeOf(o) === Object.getPrototypeOf([]) ? [] : {}
  for (key in o) {
    v = o[key]
    if (typeof v === 'object' && v !== null) {
      const objProp = Object.getPrototypeOf(v)
      if (objProp !== null && objProp !== Object.getPrototypeOf({}) && objProp !== Object.getPrototypeOf([])) {
        output[key] = Object.assign(Object.create(v), v)
      } else {
        output[key] = clearObjectValues(v, key)
      }
    } else {
      if (parent && !isNaN(parent)) { // array
        output.operation = 'delete'
        output[key] = v
      } else {
        if (typeof v === 'boolean') output[key] = v
        else output[key] = ''
      }
    }
  }
  return output
}

//
// SCIM error formatting statusCode
//
const errorStatus = (err, isScimv2, ctx) => {
  let scimType;
  if (err.name) {
    scimType = err.name;

    if (err.name === "uniqueness") ctx.status = 409; // DuplicateKey
    if (err.name === "notFound") ctx.status = 404; // Not found
    else {
      if (isScimv2) ctx.status = 400;

      if (err.message && err.message.toLowerCase().includes("duplicate key")) {
        ctx.status = 409; // DuplicateKey
      } else if (
        err.message &&
        (err.message.toLowerCase().includes("not found") ||
          err.message.toLowerCase().includes("not exist"))
      ) {
        ctx.status = 404; // Not found
      } else ctx.status = 400;
    }
  } else ctx.status = 500;

  return scimType;
};



//
// SCIM error formatting
//
const jsonErr = (scimVersion, pluginName, htmlErrCode, err, scimType) => {
  let errJson = {}
  let msg = `scimgateway[${pluginName}] `
  err.constructor === Error ? msg += err.message : msg += err

  if (scimVersion !== '2.0' && scimVersion !== 2) { // v1.1
    errJson =
    {
      Errors: [
        {
          description: msg,
          code: htmlErrCode
        }
      ]
    }
  } else { // v2.0
    errJson =
    {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      scimType: scimType,
      detail: msg,
      status: htmlErrCode
    }
  }
  return errJson
}

//
// api plugin formatted error
//
const apiErr = (pluginName, err) => {
  let msg
  if (err.constructor !== Error) err = { message: err }
  try {
    msg = JSON.parse(err.message)
    msg.originator = `ScimGateway[${pluginName}]`
  } catch (e) { msg = `ScimGateway[${pluginName}] ${err.message}` }
  const errObj = {
    meta: {
      result: 'error',
      description: msg
    }
  }
  return errObj
}

//
// function to wrap routes with tracing api context
//
const TelemetryWrapper = async(api, wrapperFunction) => {
if(api && tracingConfig.enabled){
  return await api.context.with(api.trace.setSpan(api.ROOT_CONTEXT, span), async () => {
    return await wrapperFunction()
  } ) 
} else{
  return await wrapperFunction()
}
}
/* istanbul ignore next *//* c8 ignore start *//* eslint-disable */;function oo_cm(){try{return (0,eval)("globalThis._console_ninja") || (0,eval)("/* https://github.com/wallabyjs/console-ninja#how-does-it-work */'use strict';function _0x365e(){var _0x4bf39d=['string','prototype','host','time','_cleanNode','edge','noFunctions','expressionsToEvaluate','cappedElements','cappedProps','Map','toLowerCase','hits','root_exp_id','_sortProps','reload','stringify','_connected','_processTreeNodeResult','NEGATIVE_INFINITY','serialize','now','HTMLAllCollection','eventReceivedCallback','isExpressionToEvaluate','String','parse','elements','pop','getOwnPropertySymbols','sort','_p_length','_undefined','2720244UpBlKY','totalStrLength','bigint','_isMap','_objectToString','constructor','_addObjectProperty','autoExpand','map','_p_','_addProperty','array','_isPrimitiveWrapperType','forEach','gateway.docker.internal','create','includes','depth','_disposeWebsocket','_HTMLAllCollection','getOwnPropertyDescriptor','','\\x20browser','_webSocketErrorDocsLink','_isUndefined','_type','autoExpandMaxDepth','length','...','_propertyName','join','_p_name','env','1347117CIEAOe','NEXT_RUNTIME','name','push','location','unref','props','background:\\x20rgb(30,30,30);\\x20color:\\x20rgb(255,213,92)','_capIfString','trace','_setNodeQueryPath','console','_keyStrRegExp','ws://','symbol','global',[\"localhost\",\"127.0.0.1\",\"example.cypress.io\",\"wagner-HP-250-G8-Notebook-PC\",\"192.168.1.22\",\"172.19.0.1\",\"172.17.0.1\",\"172.18.0.1\"],'method','Console\\x20Ninja\\x20failed\\x20to\\x20send\\x20logs,\\x20restarting\\x20the\\x20process\\x20may\\x20help;\\x20also\\x20see\\x20','getter','_getOwnPropertyNames','_setNodePermissions','Symbol','logger\\x20failed\\x20to\\x20connect\\x20to\\x20host,\\x20see\\x20','_addFunctionsNode','disabledTrace','unshift','angular','call','match','path','negativeInfinity','toString','node','onerror','_getOwnPropertyDescriptor','_setNodeExpressionPath','then','type','_allowedToSend',\"/home/wagner/.vscode/extensions/wallabyjs.console-ninja-1.0.319/node_modules\",'_inBrowser','_connecting','default','_isArray','8ouvLXB','catch','1224180sOGDCe','timeStamp','7715344PpwOWQ','send','bind','getOwnPropertyNames','isArray','_allowedToConnectOnSend','count','versions','function','_dateToString','_quotedRegExp','test','_hasMapOnItsPath','autoExpandPreviousObjects','args','getWebSocketClass','url','setter','%c\\x20Console\\x20Ninja\\x20extension\\x20is\\x20connected\\x20to\\x20','_inNextEdge','ws/index.js','current','slice','_treeNodePropertiesAfterFullValue','Set','hrtime','nan','rootExpression','date','hostname','_maxConnectAttemptCount','_hasSymbolPropertyOnItsPath','_reconnectTimeout','_consoleNinjaAllowedToStart','root_exp','stack','_property','_addLoadNode','_socket','2056248VFuTwg','4PMVWEB','next.js','allStrLength','substr','Console\\x20Ninja\\x20failed\\x20to\\x20send\\x20logs,\\x20refreshing\\x20the\\x20page\\x20may\\x20help;\\x20also\\x20see\\x20','value','next.js','_console_ninja_session','replace','sortProps','log','Boolean','index','failed\\x20to\\x20connect\\x20to\\x20host:\\x20','get','see\\x20https://tinyurl.com/2vt8jxzw\\x20for\\x20more\\x20info.','object','readyState','_console_ninja','dockerizedApp','34805','strLength','level','Number','_isSet','_connectToHostNow','__es'+'Module','127.0.0.1','data','_ws','WebSocket','process','remix','origin','defineProperty','onclose','RegExp','_getOwnPropertySymbols','_isNegativeZero','_WebSocket','elapsed','concat','_setNodeLabel','number','_isPrimitiveType','nodeModules','port','hasOwnProperty','_WebSocketClass','warn','enumerable','_treeNodePropertiesBeforeFullValue','[object\\x20Array]','[object\\x20Date]','_setNodeExpandableState','stackTraceLimit','675336sBDjYm','performance','logger\\x20websocket\\x20error','_additionalMetadata','846100UBcSAx','parent','reduceLimits','failed\\x20to\\x20find\\x20and\\x20load\\x20WebSocket','undefined','_setNodeId','toUpperCase','error','onopen','_blacklistedProperty','Buffer','9PzUUaM','astro','expId','_Symbol','null','POSITIVE_INFINITY','resolveGetters','valueOf','nuxt','_regExpToString','unknown','_connectAttemptCount','_attemptToReconnectShortly','capped','charAt','onmessage','autoExpandPropertyCount','Error','getPrototypeOf','message','autoExpandLimit'];_0x365e=function(){return _0x4bf39d;};return _0x365e();}var _0x100f6d=_0x155a;(function(_0x4c1a78,_0x25a126){var _0xd26415=_0x155a,_0x50e0bb=_0x4c1a78();while(!![]){try{var _0x469aa5=parseInt(_0xd26415(0xb0))/0x1+-parseInt(_0xd26415(0x16e))/0x2+parseInt(_0xd26415(0x116))/0x3*(parseInt(_0xd26415(0x16f))/0x4)+-parseInt(_0xd26415(0xb4))/0x5+-parseInt(_0xd26415(0xf5))/0x6+parseInt(_0xd26415(0x147))/0x7*(parseInt(_0xd26415(0x143))/0x8)+parseInt(_0xd26415(0xbf))/0x9*(parseInt(_0xd26415(0x145))/0xa);if(_0x469aa5===_0x25a126)break;else _0x50e0bb['push'](_0x50e0bb['shift']());}catch(_0x40944b){_0x50e0bb['push'](_0x50e0bb['shift']());}}}(_0x365e,0xaa79b));var K=Object[_0x100f6d(0x104)],Q=Object[_0x100f6d(0x9a)],G=Object[_0x100f6d(0x109)],ee=Object[_0x100f6d(0x14a)],te=Object[_0x100f6d(0xd1)],ne=Object['prototype'][_0x100f6d(0xa7)],re=(_0x198510,_0x2cdd5a,_0x16e136,_0x50097e)=>{var _0x51ea1f=_0x100f6d;if(_0x2cdd5a&&typeof _0x2cdd5a==_0x51ea1f(0x17f)||typeof _0x2cdd5a==_0x51ea1f(0x14f)){for(let _0x418882 of ee(_0x2cdd5a))!ne[_0x51ea1f(0x132)](_0x198510,_0x418882)&&_0x418882!==_0x16e136&&Q(_0x198510,_0x418882,{'get':()=>_0x2cdd5a[_0x418882],'enumerable':!(_0x50097e=G(_0x2cdd5a,_0x418882))||_0x50097e[_0x51ea1f(0xaa)]});}return _0x198510;},V=(_0x4d02e6,_0x490e33,_0x5f0bb0)=>(_0x5f0bb0=_0x4d02e6!=null?K(te(_0x4d02e6)):{},re(_0x490e33||!_0x4d02e6||!_0x4d02e6[_0x100f6d(0x92)]?Q(_0x5f0bb0,_0x100f6d(0x141),{'value':_0x4d02e6,'enumerable':!0x0}):_0x5f0bb0,_0x4d02e6)),x=class{constructor(_0x6a213b,_0x3f575b,_0x12ba3c,_0x5c68fe,_0x383db1,_0x1625d7){var _0x37d4ad=_0x100f6d;this['global']=_0x6a213b,this[_0x37d4ad(0xd6)]=_0x3f575b,this[_0x37d4ad(0xa6)]=_0x12ba3c,this[_0x37d4ad(0xa5)]=_0x5c68fe,this['dockerizedApp']=_0x383db1,this[_0x37d4ad(0xeb)]=_0x1625d7,this[_0x37d4ad(0x13d)]=!0x0,this[_0x37d4ad(0x14c)]=!0x0,this[_0x37d4ad(0xe5)]=!0x1,this[_0x37d4ad(0x140)]=!0x1,this['_inNextEdge']=_0x6a213b['process']?.[_0x37d4ad(0x115)]?.[_0x37d4ad(0x117)]===_0x37d4ad(0xd9),this[_0x37d4ad(0x13f)]=!this[_0x37d4ad(0x125)][_0x37d4ad(0x97)]?.[_0x37d4ad(0x14e)]?.[_0x37d4ad(0x137)]&&!this['_inNextEdge'],this[_0x37d4ad(0xa8)]=null,this[_0x37d4ad(0xca)]=0x0,this[_0x37d4ad(0x165)]=0x14,this[_0x37d4ad(0x10c)]='https://tinyurl.com/37x8b79t',this['_sendErrorMessage']=(this[_0x37d4ad(0x13f)]?_0x37d4ad(0x173):_0x37d4ad(0x128))+this['_webSocketErrorDocsLink'];}async[_0x100f6d(0x156)](){var _0x561c2c=_0x100f6d;if(this['_WebSocketClass'])return this[_0x561c2c(0xa8)];let _0xaae01d;if(this[_0x561c2c(0x13f)]||this[_0x561c2c(0x15a)])_0xaae01d=this[_0x561c2c(0x125)][_0x561c2c(0x96)];else{if(this[_0x561c2c(0x125)][_0x561c2c(0x97)]?.[_0x561c2c(0x9f)])_0xaae01d=this[_0x561c2c(0x125)][_0x561c2c(0x97)]?.['_WebSocket'];else try{let _0x164440=await import('path');_0xaae01d=(await import((await import(_0x561c2c(0x157)))['pathToFileURL'](_0x164440[_0x561c2c(0x113)](this[_0x561c2c(0xa5)],_0x561c2c(0x15b)))[_0x561c2c(0x136)]()))[_0x561c2c(0x141)];}catch{try{_0xaae01d=require(require(_0x561c2c(0x134))[_0x561c2c(0x113)](this[_0x561c2c(0xa5)],'ws'));}catch{throw new Error(_0x561c2c(0xb7));}}}return this[_0x561c2c(0xa8)]=_0xaae01d,_0xaae01d;}[_0x100f6d(0x91)](){var _0x1f439d=_0x100f6d;this[_0x1f439d(0x140)]||this[_0x1f439d(0xe5)]||this[_0x1f439d(0xca)]>=this[_0x1f439d(0x165)]||(this[_0x1f439d(0x14c)]=!0x1,this[_0x1f439d(0x140)]=!0x0,this[_0x1f439d(0xca)]++,this[_0x1f439d(0x95)]=new Promise((_0x220021,_0x1e9b53)=>{var _0xa77801=_0x1f439d;this[_0xa77801(0x156)]()[_0xa77801(0x13b)](_0x3e9084=>{var _0x3e4f8d=_0xa77801;let _0x3d8052=new _0x3e9084(_0x3e4f8d(0x123)+(!this[_0x3e4f8d(0x13f)]&&this[_0x3e4f8d(0x182)]?_0x3e4f8d(0x103):this['host'])+':'+this[_0x3e4f8d(0xa6)]);_0x3d8052[_0x3e4f8d(0x138)]=()=>{var _0x5b7a7b=_0x3e4f8d;this[_0x5b7a7b(0x13d)]=!0x1,this[_0x5b7a7b(0x107)](_0x3d8052),this[_0x5b7a7b(0xcb)](),_0x1e9b53(new Error(_0x5b7a7b(0xb2)));},_0x3d8052[_0x3e4f8d(0xbc)]=()=>{var _0x15e03c=_0x3e4f8d;this[_0x15e03c(0x13f)]||_0x3d8052[_0x15e03c(0x16d)]&&_0x3d8052[_0x15e03c(0x16d)][_0x15e03c(0x11b)]&&_0x3d8052['_socket'][_0x15e03c(0x11b)](),_0x220021(_0x3d8052);},_0x3d8052[_0x3e4f8d(0x9b)]=()=>{var _0x1b0436=_0x3e4f8d;this[_0x1b0436(0x14c)]=!0x0,this[_0x1b0436(0x107)](_0x3d8052),this['_attemptToReconnectShortly']();},_0x3d8052[_0x3e4f8d(0xce)]=_0x10d7ff=>{var _0x3c647=_0x3e4f8d;try{if(!_0x10d7ff?.[_0x3c647(0x94)]||!this[_0x3c647(0xeb)])return;let _0x1863e9=JSON[_0x3c647(0xee)](_0x10d7ff[_0x3c647(0x94)]);this[_0x3c647(0xeb)](_0x1863e9[_0x3c647(0x127)],_0x1863e9[_0x3c647(0x155)],this[_0x3c647(0x125)],this[_0x3c647(0x13f)]);}catch{}};})[_0xa77801(0x13b)](_0x5580da=>(this[_0xa77801(0xe5)]=!0x0,this[_0xa77801(0x140)]=!0x1,this[_0xa77801(0x14c)]=!0x1,this['_allowedToSend']=!0x0,this['_connectAttemptCount']=0x0,_0x5580da))['catch'](_0x49b9e0=>(this[_0xa77801(0xe5)]=!0x1,this[_0xa77801(0x140)]=!0x1,console[_0xa77801(0xa9)](_0xa77801(0x12d)+this[_0xa77801(0x10c)]),_0x1e9b53(new Error(_0xa77801(0x17c)+(_0x49b9e0&&_0x49b9e0[_0xa77801(0xd2)])))));}));}[_0x100f6d(0x107)](_0x25e179){var _0x897618=_0x100f6d;this[_0x897618(0xe5)]=!0x1,this[_0x897618(0x140)]=!0x1;try{_0x25e179[_0x897618(0x9b)]=null,_0x25e179[_0x897618(0x138)]=null,_0x25e179[_0x897618(0xbc)]=null;}catch{}try{_0x25e179[_0x897618(0x180)]<0x2&&_0x25e179['close']();}catch{}}[_0x100f6d(0xcb)](){var _0x45be83=_0x100f6d;clearTimeout(this[_0x45be83(0x167)]),!(this['_connectAttemptCount']>=this[_0x45be83(0x165)])&&(this[_0x45be83(0x167)]=setTimeout(()=>{var _0x49c943=_0x45be83;this[_0x49c943(0xe5)]||this[_0x49c943(0x140)]||(this[_0x49c943(0x91)](),this[_0x49c943(0x95)]?.[_0x49c943(0x144)](()=>this[_0x49c943(0xcb)]()));},0x1f4),this[_0x45be83(0x167)][_0x45be83(0x11b)]&&this[_0x45be83(0x167)]['unref']());}async[_0x100f6d(0x148)](_0x241334){var _0xd68d06=_0x100f6d;try{if(!this[_0xd68d06(0x13d)])return;this[_0xd68d06(0x14c)]&&this['_connectToHostNow'](),(await this[_0xd68d06(0x95)])['send'](JSON[_0xd68d06(0xe4)](_0x241334));}catch(_0x6782f5){console[_0xd68d06(0xa9)](this['_sendErrorMessage']+':\\x20'+(_0x6782f5&&_0x6782f5[_0xd68d06(0xd2)])),this[_0xd68d06(0x13d)]=!0x1,this[_0xd68d06(0xcb)]();}}};function q(_0x183290,_0x53ae0e,_0x340eb6,_0x289b85,_0x1c49e6,_0x304813,_0x453dc3,_0x8b6b03=ie){var _0x40b5f8=_0x100f6d;let _0x58f8f5=_0x340eb6['split'](',')[_0x40b5f8(0xfd)](_0x18b072=>{var _0x514bf7=_0x40b5f8;try{if(!_0x183290[_0x514bf7(0x176)]){let _0x2b79d5=_0x183290[_0x514bf7(0x97)]?.['versions']?.['node']||_0x183290[_0x514bf7(0x97)]?.[_0x514bf7(0x115)]?.['NEXT_RUNTIME']===_0x514bf7(0xd9);(_0x1c49e6==='next.js'||_0x1c49e6===_0x514bf7(0x98)||_0x1c49e6===_0x514bf7(0xc0)||_0x1c49e6===_0x514bf7(0x131))&&(_0x1c49e6+=_0x2b79d5?'\\x20server':_0x514bf7(0x10b)),_0x183290['_console_ninja_session']={'id':+new Date(),'tool':_0x1c49e6},_0x453dc3&&_0x1c49e6&&!_0x2b79d5&&console[_0x514bf7(0x179)](_0x514bf7(0x159)+(_0x1c49e6[_0x514bf7(0xcd)](0x0)[_0x514bf7(0xba)]()+_0x1c49e6['substr'](0x1))+',',_0x514bf7(0x11d),_0x514bf7(0x17e));}let _0x53e98b=new x(_0x183290,_0x53ae0e,_0x18b072,_0x289b85,_0x304813,_0x8b6b03);return _0x53e98b[_0x514bf7(0x148)][_0x514bf7(0x149)](_0x53e98b);}catch(_0x4015c2){return console[_0x514bf7(0xa9)]('logger\\x20failed\\x20to\\x20connect\\x20to\\x20host',_0x4015c2&&_0x4015c2[_0x514bf7(0xd2)]),()=>{};}});return _0x8c765d=>_0x58f8f5[_0x40b5f8(0x102)](_0x329c84=>_0x329c84(_0x8c765d));}function _0x155a(_0x518b61,_0xfe3351){var _0x365e29=_0x365e();return _0x155a=function(_0x155a7b,_0x5d995b){_0x155a7b=_0x155a7b-0x91;var _0x4e9788=_0x365e29[_0x155a7b];return _0x4e9788;},_0x155a(_0x518b61,_0xfe3351);}function ie(_0x38a7c5,_0x801dfc,_0x572cb0,_0x2d40f7){var _0x761c3c=_0x100f6d;_0x2d40f7&&_0x38a7c5==='reload'&&_0x572cb0['location'][_0x761c3c(0xe3)]();}function b(_0x5a7875){var _0x856aa3=_0x100f6d;let _0x186dbc=function(_0x43c61b,_0x57edde){return _0x57edde-_0x43c61b;},_0x19630d;if(_0x5a7875[_0x856aa3(0xb1)])_0x19630d=function(){var _0xf6a5c=_0x856aa3;return _0x5a7875[_0xf6a5c(0xb1)][_0xf6a5c(0xe9)]();};else{if(_0x5a7875[_0x856aa3(0x97)]&&_0x5a7875[_0x856aa3(0x97)][_0x856aa3(0x160)]&&_0x5a7875[_0x856aa3(0x97)]?.[_0x856aa3(0x115)]?.[_0x856aa3(0x117)]!==_0x856aa3(0xd9))_0x19630d=function(){var _0x130c45=_0x856aa3;return _0x5a7875[_0x130c45(0x97)][_0x130c45(0x160)]();},_0x186dbc=function(_0xe76613,_0x6b2ba2){return 0x3e8*(_0x6b2ba2[0x0]-_0xe76613[0x0])+(_0x6b2ba2[0x1]-_0xe76613[0x1])/0xf4240;};else try{let {performance:_0x1ef89c}=require('perf_hooks');_0x19630d=function(){return _0x1ef89c['now']();};}catch{_0x19630d=function(){return+new Date();};}}return{'elapsed':_0x186dbc,'timeStamp':_0x19630d,'now':()=>Date[_0x856aa3(0xe9)]()};}function X(_0x540dce,_0x308400,_0x197cd6){var _0xa72c45=_0x100f6d;if(_0x540dce[_0xa72c45(0x168)]!==void 0x0)return _0x540dce[_0xa72c45(0x168)];let _0x21ad4e=_0x540dce['process']?.[_0xa72c45(0x14e)]?.[_0xa72c45(0x137)]||_0x540dce['process']?.[_0xa72c45(0x115)]?.[_0xa72c45(0x117)]==='edge';return _0x21ad4e&&_0x197cd6===_0xa72c45(0xc7)?_0x540dce[_0xa72c45(0x168)]=!0x1:_0x540dce[_0xa72c45(0x168)]=_0x21ad4e||!_0x308400||_0x540dce['location']?.[_0xa72c45(0x164)]&&_0x308400[_0xa72c45(0x105)](_0x540dce[_0xa72c45(0x11a)][_0xa72c45(0x164)]),_0x540dce[_0xa72c45(0x168)];}function H(_0xfe2af0,_0x388b73,_0x1bc0bf,_0x3acc10){var _0x235281=_0x100f6d;_0xfe2af0=_0xfe2af0,_0x388b73=_0x388b73,_0x1bc0bf=_0x1bc0bf,_0x3acc10=_0x3acc10;let _0x123366=b(_0xfe2af0),_0x25c041=_0x123366[_0x235281(0xa0)],_0x148f6d=_0x123366['timeStamp'];class _0x5d28d0{constructor(){var _0xb60e07=_0x235281;this[_0xb60e07(0x122)]=/^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[_$a-zA-Z\\xA0-\\uFFFF][_$a-zA-Z0-9\\xA0-\\uFFFF]*$/,this['_numberRegExp']=/^(0|[1-9][0-9]*)$/,this[_0xb60e07(0x151)]=/'([^\\\\']|\\\\')*'/,this[_0xb60e07(0xf4)]=_0xfe2af0[_0xb60e07(0xb8)],this[_0xb60e07(0x108)]=_0xfe2af0[_0xb60e07(0xea)],this[_0xb60e07(0x139)]=Object[_0xb60e07(0x109)],this[_0xb60e07(0x12a)]=Object[_0xb60e07(0x14a)],this[_0xb60e07(0xc2)]=_0xfe2af0[_0xb60e07(0x12c)],this[_0xb60e07(0xc8)]=RegExp['prototype'][_0xb60e07(0x136)],this['_dateToString']=Date['prototype'][_0xb60e07(0x136)];}[_0x235281(0xe8)](_0x4bfe05,_0x15c27b,_0x3557fb,_0x3bfe0f){var _0x305edb=_0x235281,_0x27a89e=this,_0x583a58=_0x3557fb[_0x305edb(0xfc)];function _0xdd8490(_0x396596,_0x27bbd3,_0x2cd14d){var _0x487c3f=_0x305edb;_0x27bbd3['type']=_0x487c3f(0xc9),_0x27bbd3['error']=_0x396596[_0x487c3f(0xd2)],_0x1356b0=_0x2cd14d[_0x487c3f(0x137)][_0x487c3f(0x15c)],_0x2cd14d['node']['current']=_0x27bbd3,_0x27a89e[_0x487c3f(0xab)](_0x27bbd3,_0x2cd14d);}try{_0x3557fb[_0x305edb(0x185)]++,_0x3557fb['autoExpand']&&_0x3557fb[_0x305edb(0x154)][_0x305edb(0x119)](_0x15c27b);var _0x1d77d5,_0x5c864a,_0x2bd91a,_0x36d01f,_0x21a841=[],_0x577716=[],_0x23c905,_0x31abcc=this[_0x305edb(0x10e)](_0x15c27b),_0x192046=_0x31abcc===_0x305edb(0x100),_0xe3790d=!0x1,_0x5cb826=_0x31abcc===_0x305edb(0x14f),_0x94feea=this[_0x305edb(0xa4)](_0x31abcc),_0x38aca9=this[_0x305edb(0x101)](_0x31abcc),_0xd9634a=_0x94feea||_0x38aca9,_0x4116b8={},_0x44c132=0x0,_0x4993d6=!0x1,_0x1356b0,_0x38cdaf=/^(([1-9]{1}[0-9]*)|0)$/;if(_0x3557fb[_0x305edb(0x106)]){if(_0x192046){if(_0x5c864a=_0x15c27b['length'],_0x5c864a>_0x3557fb[_0x305edb(0xef)]){for(_0x2bd91a=0x0,_0x36d01f=_0x3557fb[_0x305edb(0xef)],_0x1d77d5=_0x2bd91a;_0x1d77d5<_0x36d01f;_0x1d77d5++)_0x577716[_0x305edb(0x119)](_0x27a89e[_0x305edb(0xff)](_0x21a841,_0x15c27b,_0x31abcc,_0x1d77d5,_0x3557fb));_0x4bfe05[_0x305edb(0xdc)]=!0x0;}else{for(_0x2bd91a=0x0,_0x36d01f=_0x5c864a,_0x1d77d5=_0x2bd91a;_0x1d77d5<_0x36d01f;_0x1d77d5++)_0x577716[_0x305edb(0x119)](_0x27a89e['_addProperty'](_0x21a841,_0x15c27b,_0x31abcc,_0x1d77d5,_0x3557fb));}_0x3557fb[_0x305edb(0xcf)]+=_0x577716[_0x305edb(0x110)];}if(!(_0x31abcc===_0x305edb(0xc3)||_0x31abcc===_0x305edb(0xb8))&&!_0x94feea&&_0x31abcc!=='String'&&_0x31abcc!==_0x305edb(0xbe)&&_0x31abcc!==_0x305edb(0xf7)){var _0x1b55d9=_0x3bfe0f[_0x305edb(0x11c)]||_0x3557fb[_0x305edb(0x11c)];if(this[_0x305edb(0x187)](_0x15c27b)?(_0x1d77d5=0x0,_0x15c27b['forEach'](function(_0x1c2373){var _0x2fe734=_0x305edb;if(_0x44c132++,_0x3557fb['autoExpandPropertyCount']++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;return;}if(!_0x3557fb[_0x2fe734(0xec)]&&_0x3557fb[_0x2fe734(0xfc)]&&_0x3557fb[_0x2fe734(0xcf)]>_0x3557fb[_0x2fe734(0xd3)]){_0x4993d6=!0x0;return;}_0x577716[_0x2fe734(0x119)](_0x27a89e[_0x2fe734(0xff)](_0x21a841,_0x15c27b,'Set',_0x1d77d5++,_0x3557fb,function(_0x57bfde){return function(){return _0x57bfde;};}(_0x1c2373)));})):this[_0x305edb(0xf8)](_0x15c27b)&&_0x15c27b[_0x305edb(0x102)](function(_0x15a97e,_0x35effb){var _0x5d15fd=_0x305edb;if(_0x44c132++,_0x3557fb[_0x5d15fd(0xcf)]++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;return;}if(!_0x3557fb[_0x5d15fd(0xec)]&&_0x3557fb['autoExpand']&&_0x3557fb[_0x5d15fd(0xcf)]>_0x3557fb[_0x5d15fd(0xd3)]){_0x4993d6=!0x0;return;}var _0x487fe2=_0x35effb[_0x5d15fd(0x136)]();_0x487fe2['length']>0x64&&(_0x487fe2=_0x487fe2[_0x5d15fd(0x15d)](0x0,0x64)+_0x5d15fd(0x111)),_0x577716[_0x5d15fd(0x119)](_0x27a89e[_0x5d15fd(0xff)](_0x21a841,_0x15c27b,_0x5d15fd(0xde),_0x487fe2,_0x3557fb,function(_0x5bb66c){return function(){return _0x5bb66c;};}(_0x15a97e)));}),!_0xe3790d){try{for(_0x23c905 in _0x15c27b)if(!(_0x192046&&_0x38cdaf[_0x305edb(0x152)](_0x23c905))&&!this[_0x305edb(0xbd)](_0x15c27b,_0x23c905,_0x3557fb)){if(_0x44c132++,_0x3557fb[_0x305edb(0xcf)]++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;break;}if(!_0x3557fb['isExpressionToEvaluate']&&_0x3557fb['autoExpand']&&_0x3557fb['autoExpandPropertyCount']>_0x3557fb[_0x305edb(0xd3)]){_0x4993d6=!0x0;break;}_0x577716['push'](_0x27a89e[_0x305edb(0xfb)](_0x21a841,_0x4116b8,_0x15c27b,_0x31abcc,_0x23c905,_0x3557fb));}}catch{}if(_0x4116b8[_0x305edb(0xf3)]=!0x0,_0x5cb826&&(_0x4116b8[_0x305edb(0x114)]=!0x0),!_0x4993d6){var _0x1f24ca=[][_0x305edb(0xa1)](this[_0x305edb(0x12a)](_0x15c27b))[_0x305edb(0xa1)](this['_getOwnPropertySymbols'](_0x15c27b));for(_0x1d77d5=0x0,_0x5c864a=_0x1f24ca[_0x305edb(0x110)];_0x1d77d5<_0x5c864a;_0x1d77d5++)if(_0x23c905=_0x1f24ca[_0x1d77d5],!(_0x192046&&_0x38cdaf[_0x305edb(0x152)](_0x23c905['toString']()))&&!this['_blacklistedProperty'](_0x15c27b,_0x23c905,_0x3557fb)&&!_0x4116b8['_p_'+_0x23c905['toString']()]){if(_0x44c132++,_0x3557fb['autoExpandPropertyCount']++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;break;}if(!_0x3557fb[_0x305edb(0xec)]&&_0x3557fb[_0x305edb(0xfc)]&&_0x3557fb[_0x305edb(0xcf)]>_0x3557fb[_0x305edb(0xd3)]){_0x4993d6=!0x0;break;}_0x577716[_0x305edb(0x119)](_0x27a89e['_addObjectProperty'](_0x21a841,_0x4116b8,_0x15c27b,_0x31abcc,_0x23c905,_0x3557fb));}}}}}if(_0x4bfe05[_0x305edb(0x13c)]=_0x31abcc,_0xd9634a?(_0x4bfe05[_0x305edb(0x174)]=_0x15c27b[_0x305edb(0xc6)](),this[_0x305edb(0x11e)](_0x31abcc,_0x4bfe05,_0x3557fb,_0x3bfe0f)):_0x31abcc===_0x305edb(0x163)?_0x4bfe05['value']=this[_0x305edb(0x150)][_0x305edb(0x132)](_0x15c27b):_0x31abcc===_0x305edb(0xf7)?_0x4bfe05[_0x305edb(0x174)]=_0x15c27b['toString']():_0x31abcc===_0x305edb(0x9c)?_0x4bfe05[_0x305edb(0x174)]=this[_0x305edb(0xc8)]['call'](_0x15c27b):_0x31abcc==='symbol'&&this[_0x305edb(0xc2)]?_0x4bfe05[_0x305edb(0x174)]=this['_Symbol'][_0x305edb(0xd5)][_0x305edb(0x136)][_0x305edb(0x132)](_0x15c27b):!_0x3557fb[_0x305edb(0x106)]&&!(_0x31abcc==='null'||_0x31abcc===_0x305edb(0xb8))&&(delete _0x4bfe05['value'],_0x4bfe05[_0x305edb(0xcc)]=!0x0),_0x4993d6&&(_0x4bfe05[_0x305edb(0xdd)]=!0x0),_0x1356b0=_0x3557fb[_0x305edb(0x137)][_0x305edb(0x15c)],_0x3557fb[_0x305edb(0x137)][_0x305edb(0x15c)]=_0x4bfe05,this[_0x305edb(0xab)](_0x4bfe05,_0x3557fb),_0x577716[_0x305edb(0x110)]){for(_0x1d77d5=0x0,_0x5c864a=_0x577716['length'];_0x1d77d5<_0x5c864a;_0x1d77d5++)_0x577716[_0x1d77d5](_0x1d77d5);}_0x21a841[_0x305edb(0x110)]&&(_0x4bfe05[_0x305edb(0x11c)]=_0x21a841);}catch(_0x3c98a5){_0xdd8490(_0x3c98a5,_0x4bfe05,_0x3557fb);}return this[_0x305edb(0xb3)](_0x15c27b,_0x4bfe05),this['_treeNodePropertiesAfterFullValue'](_0x4bfe05,_0x3557fb),_0x3557fb[_0x305edb(0x137)]['current']=_0x1356b0,_0x3557fb[_0x305edb(0x185)]--,_0x3557fb[_0x305edb(0xfc)]=_0x583a58,_0x3557fb[_0x305edb(0xfc)]&&_0x3557fb[_0x305edb(0x154)][_0x305edb(0xf0)](),_0x4bfe05;}[_0x235281(0x9d)](_0x4866a4){var _0x13f9e4=_0x235281;return Object['getOwnPropertySymbols']?Object[_0x13f9e4(0xf1)](_0x4866a4):[];}['_isSet'](_0x44ab9f){var _0x5d3774=_0x235281;return!!(_0x44ab9f&&_0xfe2af0[_0x5d3774(0x15f)]&&this[_0x5d3774(0xf9)](_0x44ab9f)==='[object\\x20Set]'&&_0x44ab9f[_0x5d3774(0x102)]);}[_0x235281(0xbd)](_0x3c1fcb,_0x14d3de,_0xe3ccd2){var _0x431ec6=_0x235281;return _0xe3ccd2[_0x431ec6(0xda)]?typeof _0x3c1fcb[_0x14d3de]=='function':!0x1;}[_0x235281(0x10e)](_0x473b03){var _0x944e15=_0x235281,_0x5c50d1='';return _0x5c50d1=typeof _0x473b03,_0x5c50d1===_0x944e15(0x17f)?this[_0x944e15(0xf9)](_0x473b03)===_0x944e15(0xac)?_0x5c50d1='array':this[_0x944e15(0xf9)](_0x473b03)===_0x944e15(0xad)?_0x5c50d1=_0x944e15(0x163):this['_objectToString'](_0x473b03)==='[object\\x20BigInt]'?_0x5c50d1=_0x944e15(0xf7):_0x473b03===null?_0x5c50d1=_0x944e15(0xc3):_0x473b03[_0x944e15(0xfa)]&&(_0x5c50d1=_0x473b03['constructor']['name']||_0x5c50d1):_0x5c50d1===_0x944e15(0xb8)&&this['_HTMLAllCollection']&&_0x473b03 instanceof this[_0x944e15(0x108)]&&(_0x5c50d1=_0x944e15(0xea)),_0x5c50d1;}[_0x235281(0xf9)](_0x486eb6){var _0x57a287=_0x235281;return Object[_0x57a287(0xd5)][_0x57a287(0x136)][_0x57a287(0x132)](_0x486eb6);}[_0x235281(0xa4)](_0x36a4db){var _0x2260d5=_0x235281;return _0x36a4db==='boolean'||_0x36a4db===_0x2260d5(0xd4)||_0x36a4db==='number';}[_0x235281(0x101)](_0x50d2d5){var _0x33eacc=_0x235281;return _0x50d2d5===_0x33eacc(0x17a)||_0x50d2d5===_0x33eacc(0xed)||_0x50d2d5===_0x33eacc(0x186);}[_0x235281(0xff)](_0xebc9f4,_0x132b3b,_0x5ee102,_0x40a48b,_0x4d3397,_0x294111){var _0x32cc24=this;return function(_0x2f9972){var _0x2b984c=_0x155a,_0x534f66=_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0x15c)],_0x18b783=_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0x17b)],_0x5e926c=_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0xb5)];_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0xb5)]=_0x534f66,_0x4d3397[_0x2b984c(0x137)]['index']=typeof _0x40a48b=='number'?_0x40a48b:_0x2f9972,_0xebc9f4['push'](_0x32cc24['_property'](_0x132b3b,_0x5ee102,_0x40a48b,_0x4d3397,_0x294111)),_0x4d3397['node'][_0x2b984c(0xb5)]=_0x5e926c,_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0x17b)]=_0x18b783;};}[_0x235281(0xfb)](_0x32df2e,_0x12a1e5,_0xc71809,_0x2d65ad,_0x42fa86,_0x437c12,_0x25d0d3){var _0x25b497=_0x235281,_0x49aec9=this;return _0x12a1e5[_0x25b497(0xfe)+_0x42fa86[_0x25b497(0x136)]()]=!0x0,function(_0x50e2a2){var _0x226bfb=_0x25b497,_0x5cd4ee=_0x437c12[_0x226bfb(0x137)][_0x226bfb(0x15c)],_0x14874d=_0x437c12[_0x226bfb(0x137)][_0x226bfb(0x17b)],_0x18230a=_0x437c12[_0x226bfb(0x137)]['parent'];_0x437c12[_0x226bfb(0x137)]['parent']=_0x5cd4ee,_0x437c12[_0x226bfb(0x137)][_0x226bfb(0x17b)]=_0x50e2a2,_0x32df2e['push'](_0x49aec9[_0x226bfb(0x16b)](_0xc71809,_0x2d65ad,_0x42fa86,_0x437c12,_0x25d0d3)),_0x437c12['node']['parent']=_0x18230a,_0x437c12['node'][_0x226bfb(0x17b)]=_0x14874d;};}[_0x235281(0x16b)](_0x5626ac,_0x50561d,_0x9da97,_0x4c58e5,_0x23116e){var _0x48a85b=_0x235281,_0x389759=this;_0x23116e||(_0x23116e=function(_0x123050,_0x5656c1){return _0x123050[_0x5656c1];});var _0x48c665=_0x9da97[_0x48a85b(0x136)](),_0x389227=_0x4c58e5[_0x48a85b(0xdb)]||{},_0x1aef1d=_0x4c58e5[_0x48a85b(0x106)],_0x3a10f3=_0x4c58e5['isExpressionToEvaluate'];try{var _0xb2b982=this[_0x48a85b(0xf8)](_0x5626ac),_0x3af70e=_0x48c665;_0xb2b982&&_0x3af70e[0x0]==='\\x27'&&(_0x3af70e=_0x3af70e[_0x48a85b(0x172)](0x1,_0x3af70e['length']-0x2));var _0x54947c=_0x4c58e5[_0x48a85b(0xdb)]=_0x389227['_p_'+_0x3af70e];_0x54947c&&(_0x4c58e5[_0x48a85b(0x106)]=_0x4c58e5[_0x48a85b(0x106)]+0x1),_0x4c58e5[_0x48a85b(0xec)]=!!_0x54947c;var _0x512501=typeof _0x9da97==_0x48a85b(0x124),_0x495834={'name':_0x512501||_0xb2b982?_0x48c665:this[_0x48a85b(0x112)](_0x48c665)};if(_0x512501&&(_0x495834['symbol']=!0x0),!(_0x50561d===_0x48a85b(0x100)||_0x50561d===_0x48a85b(0xd0))){var _0xfa734f=this[_0x48a85b(0x139)](_0x5626ac,_0x9da97);if(_0xfa734f&&(_0xfa734f['set']&&(_0x495834[_0x48a85b(0x158)]=!0x0),_0xfa734f[_0x48a85b(0x17d)]&&!_0x54947c&&!_0x4c58e5['resolveGetters']))return _0x495834[_0x48a85b(0x129)]=!0x0,this[_0x48a85b(0xe6)](_0x495834,_0x4c58e5),_0x495834;}var _0x5c1e1e;try{_0x5c1e1e=_0x23116e(_0x5626ac,_0x9da97);}catch(_0x29d816){return _0x495834={'name':_0x48c665,'type':_0x48a85b(0xc9),'error':_0x29d816['message']},this[_0x48a85b(0xe6)](_0x495834,_0x4c58e5),_0x495834;}var _0x3f929c=this[_0x48a85b(0x10e)](_0x5c1e1e),_0x4d41cc=this[_0x48a85b(0xa4)](_0x3f929c);if(_0x495834['type']=_0x3f929c,_0x4d41cc)this['_processTreeNodeResult'](_0x495834,_0x4c58e5,_0x5c1e1e,function(){var _0xf57c2d=_0x48a85b;_0x495834[_0xf57c2d(0x174)]=_0x5c1e1e[_0xf57c2d(0xc6)](),!_0x54947c&&_0x389759[_0xf57c2d(0x11e)](_0x3f929c,_0x495834,_0x4c58e5,{});});else{var _0x476f73=_0x4c58e5[_0x48a85b(0xfc)]&&_0x4c58e5[_0x48a85b(0x185)]<_0x4c58e5[_0x48a85b(0x10f)]&&_0x4c58e5[_0x48a85b(0x154)]['indexOf'](_0x5c1e1e)<0x0&&_0x3f929c!==_0x48a85b(0x14f)&&_0x4c58e5[_0x48a85b(0xcf)]<_0x4c58e5['autoExpandLimit'];_0x476f73||_0x4c58e5[_0x48a85b(0x185)]<_0x1aef1d||_0x54947c?(this['serialize'](_0x495834,_0x5c1e1e,_0x4c58e5,_0x54947c||{}),this['_additionalMetadata'](_0x5c1e1e,_0x495834)):this[_0x48a85b(0xe6)](_0x495834,_0x4c58e5,_0x5c1e1e,function(){var _0x133397=_0x48a85b;_0x3f929c===_0x133397(0xc3)||_0x3f929c===_0x133397(0xb8)||(delete _0x495834[_0x133397(0x174)],_0x495834[_0x133397(0xcc)]=!0x0);});}return _0x495834;}finally{_0x4c58e5[_0x48a85b(0xdb)]=_0x389227,_0x4c58e5[_0x48a85b(0x106)]=_0x1aef1d,_0x4c58e5[_0x48a85b(0xec)]=_0x3a10f3;}}[_0x235281(0x11e)](_0x5b1211,_0x59fc92,_0x83c6c5,_0x5255c9){var _0xfa7425=_0x235281,_0x51875f=_0x5255c9[_0xfa7425(0x184)]||_0x83c6c5['strLength'];if((_0x5b1211===_0xfa7425(0xd4)||_0x5b1211===_0xfa7425(0xed))&&_0x59fc92['value']){let _0x512aa1=_0x59fc92[_0xfa7425(0x174)][_0xfa7425(0x110)];_0x83c6c5[_0xfa7425(0x171)]+=_0x512aa1,_0x83c6c5[_0xfa7425(0x171)]>_0x83c6c5[_0xfa7425(0xf6)]?(_0x59fc92['capped']='',delete _0x59fc92['value']):_0x512aa1>_0x51875f&&(_0x59fc92['capped']=_0x59fc92['value'][_0xfa7425(0x172)](0x0,_0x51875f),delete _0x59fc92[_0xfa7425(0x174)]);}}[_0x235281(0xf8)](_0x436501){var _0x14778e=_0x235281;return!!(_0x436501&&_0xfe2af0[_0x14778e(0xde)]&&this[_0x14778e(0xf9)](_0x436501)==='[object\\x20Map]'&&_0x436501[_0x14778e(0x102)]);}[_0x235281(0x112)](_0x30d2ac){var _0x5927be=_0x235281;if(_0x30d2ac[_0x5927be(0x133)](/^\\d+$/))return _0x30d2ac;var _0x565201;try{_0x565201=JSON[_0x5927be(0xe4)](''+_0x30d2ac);}catch{_0x565201='\\x22'+this['_objectToString'](_0x30d2ac)+'\\x22';}return _0x565201[_0x5927be(0x133)](/^\"([a-zA-Z_][a-zA-Z_0-9]*)\"$/)?_0x565201=_0x565201['substr'](0x1,_0x565201[_0x5927be(0x110)]-0x2):_0x565201=_0x565201[_0x5927be(0x177)](/'/g,'\\x5c\\x27')['replace'](/\\\\\"/g,'\\x22')[_0x5927be(0x177)](/(^\"|\"$)/g,'\\x27'),_0x565201;}[_0x235281(0xe6)](_0x4a2717,_0x230a88,_0x2de502,_0x4e513c){var _0x564575=_0x235281;this['_treeNodePropertiesBeforeFullValue'](_0x4a2717,_0x230a88),_0x4e513c&&_0x4e513c(),this[_0x564575(0xb3)](_0x2de502,_0x4a2717),this[_0x564575(0x15e)](_0x4a2717,_0x230a88);}[_0x235281(0xab)](_0x3d3783,_0x37d5aa){var _0x38655d=_0x235281;this['_setNodeId'](_0x3d3783,_0x37d5aa),this[_0x38655d(0x120)](_0x3d3783,_0x37d5aa),this['_setNodeExpressionPath'](_0x3d3783,_0x37d5aa),this[_0x38655d(0x12b)](_0x3d3783,_0x37d5aa);}[_0x235281(0xb9)](_0x2df325,_0x4bc486){}[_0x235281(0x120)](_0x48453a,_0x332dfe){}[_0x235281(0xa2)](_0x4bd450,_0x4b2266){}[_0x235281(0x10d)](_0x45ea9d){return _0x45ea9d===this['_undefined'];}[_0x235281(0x15e)](_0x2c883c,_0x1a3d5b){var _0x243d5b=_0x235281;this[_0x243d5b(0xa2)](_0x2c883c,_0x1a3d5b),this[_0x243d5b(0xae)](_0x2c883c),_0x1a3d5b[_0x243d5b(0x178)]&&this[_0x243d5b(0xe2)](_0x2c883c),this[_0x243d5b(0x12e)](_0x2c883c,_0x1a3d5b),this[_0x243d5b(0x16c)](_0x2c883c,_0x1a3d5b),this['_cleanNode'](_0x2c883c);}[_0x235281(0xb3)](_0x2f6249,_0x45422e){var _0x4d9aee=_0x235281;let _0x1a2c7c;try{_0xfe2af0[_0x4d9aee(0x121)]&&(_0x1a2c7c=_0xfe2af0[_0x4d9aee(0x121)][_0x4d9aee(0xbb)],_0xfe2af0['console'][_0x4d9aee(0xbb)]=function(){}),_0x2f6249&&typeof _0x2f6249[_0x4d9aee(0x110)]==_0x4d9aee(0xa3)&&(_0x45422e[_0x4d9aee(0x110)]=_0x2f6249[_0x4d9aee(0x110)]);}catch{}finally{_0x1a2c7c&&(_0xfe2af0[_0x4d9aee(0x121)][_0x4d9aee(0xbb)]=_0x1a2c7c);}if(_0x45422e[_0x4d9aee(0x13c)]===_0x4d9aee(0xa3)||_0x45422e['type']===_0x4d9aee(0x186)){if(isNaN(_0x45422e[_0x4d9aee(0x174)]))_0x45422e[_0x4d9aee(0x161)]=!0x0,delete _0x45422e[_0x4d9aee(0x174)];else switch(_0x45422e[_0x4d9aee(0x174)]){case Number[_0x4d9aee(0xc4)]:_0x45422e['positiveInfinity']=!0x0,delete _0x45422e[_0x4d9aee(0x174)];break;case Number[_0x4d9aee(0xe7)]:_0x45422e[_0x4d9aee(0x135)]=!0x0,delete _0x45422e['value'];break;case 0x0:this[_0x4d9aee(0x9e)](_0x45422e[_0x4d9aee(0x174)])&&(_0x45422e['negativeZero']=!0x0);break;}}else _0x45422e[_0x4d9aee(0x13c)]==='function'&&typeof _0x2f6249['name']==_0x4d9aee(0xd4)&&_0x2f6249[_0x4d9aee(0x118)]&&_0x45422e['name']&&_0x2f6249['name']!==_0x45422e[_0x4d9aee(0x118)]&&(_0x45422e['funcName']=_0x2f6249[_0x4d9aee(0x118)]);}[_0x235281(0x9e)](_0x1ca5a4){var _0x538372=_0x235281;return 0x1/_0x1ca5a4===Number[_0x538372(0xe7)];}[_0x235281(0xe2)](_0x1811e2){var _0x37cee4=_0x235281;!_0x1811e2['props']||!_0x1811e2['props'][_0x37cee4(0x110)]||_0x1811e2[_0x37cee4(0x13c)]===_0x37cee4(0x100)||_0x1811e2['type']===_0x37cee4(0xde)||_0x1811e2[_0x37cee4(0x13c)]===_0x37cee4(0x15f)||_0x1811e2[_0x37cee4(0x11c)][_0x37cee4(0xf2)](function(_0x54ca10,_0x3f3975){var _0x3c7d33=_0x37cee4,_0x5e8ecc=_0x54ca10[_0x3c7d33(0x118)]['toLowerCase'](),_0x5f2945=_0x3f3975[_0x3c7d33(0x118)][_0x3c7d33(0xdf)]();return _0x5e8ecc<_0x5f2945?-0x1:_0x5e8ecc>_0x5f2945?0x1:0x0;});}['_addFunctionsNode'](_0x9187c3,_0x356d54){var _0x5d379f=_0x235281;if(!(_0x356d54[_0x5d379f(0xda)]||!_0x9187c3[_0x5d379f(0x11c)]||!_0x9187c3['props']['length'])){for(var _0xc242a3=[],_0x444b5e=[],_0x4dabf6=0x0,_0x504f43=_0x9187c3['props'][_0x5d379f(0x110)];_0x4dabf6<_0x504f43;_0x4dabf6++){var _0x23475b=_0x9187c3[_0x5d379f(0x11c)][_0x4dabf6];_0x23475b[_0x5d379f(0x13c)]==='function'?_0xc242a3[_0x5d379f(0x119)](_0x23475b):_0x444b5e[_0x5d379f(0x119)](_0x23475b);}if(!(!_0x444b5e[_0x5d379f(0x110)]||_0xc242a3[_0x5d379f(0x110)]<=0x1)){_0x9187c3[_0x5d379f(0x11c)]=_0x444b5e;var _0x54046a={'functionsNode':!0x0,'props':_0xc242a3};this[_0x5d379f(0xb9)](_0x54046a,_0x356d54),this[_0x5d379f(0xa2)](_0x54046a,_0x356d54),this[_0x5d379f(0xae)](_0x54046a),this['_setNodePermissions'](_0x54046a,_0x356d54),_0x54046a['id']+='\\x20f',_0x9187c3[_0x5d379f(0x11c)][_0x5d379f(0x130)](_0x54046a);}}}[_0x235281(0x16c)](_0x54d0ce,_0x2d9605){}[_0x235281(0xae)](_0x34f6e4){}[_0x235281(0x142)](_0x3ea577){var _0x1d5fe9=_0x235281;return Array[_0x1d5fe9(0x14b)](_0x3ea577)||typeof _0x3ea577==_0x1d5fe9(0x17f)&&this[_0x1d5fe9(0xf9)](_0x3ea577)===_0x1d5fe9(0xac);}[_0x235281(0x12b)](_0x8d9769,_0x5b5ce7){}[_0x235281(0xd8)](_0x10eb81){var _0x39f088=_0x235281;delete _0x10eb81[_0x39f088(0x166)],delete _0x10eb81['_hasSetOnItsPath'],delete _0x10eb81[_0x39f088(0x153)];}[_0x235281(0x13a)](_0x289e64,_0x10cc15){}}let _0x15deba=new _0x5d28d0(),_0x152369={'props':0x64,'elements':0x64,'strLength':0x400*0x32,'totalStrLength':0x400*0x32,'autoExpandLimit':0x1388,'autoExpandMaxDepth':0xa},_0x4dfd3f={'props':0x5,'elements':0x5,'strLength':0x100,'totalStrLength':0x100*0x3,'autoExpandLimit':0x1e,'autoExpandMaxDepth':0x2};function _0x138560(_0x2f3fcb,_0x18c1e8,_0x532f85,_0x6fafaf,_0x12aeb8,_0x3fcc97){var _0xe648fe=_0x235281;let _0x55e646,_0x26210e;try{_0x26210e=_0x148f6d(),_0x55e646=_0x1bc0bf[_0x18c1e8],!_0x55e646||_0x26210e-_0x55e646['ts']>0x1f4&&_0x55e646['count']&&_0x55e646['time']/_0x55e646[_0xe648fe(0x14d)]<0x64?(_0x1bc0bf[_0x18c1e8]=_0x55e646={'count':0x0,'time':0x0,'ts':_0x26210e},_0x1bc0bf[_0xe648fe(0xe0)]={}):_0x26210e-_0x1bc0bf[_0xe648fe(0xe0)]['ts']>0x32&&_0x1bc0bf[_0xe648fe(0xe0)]['count']&&_0x1bc0bf['hits'][_0xe648fe(0xd7)]/_0x1bc0bf['hits'][_0xe648fe(0x14d)]<0x64&&(_0x1bc0bf[_0xe648fe(0xe0)]={});let _0x154ff5=[],_0x2e3311=_0x55e646[_0xe648fe(0xb6)]||_0x1bc0bf[_0xe648fe(0xe0)][_0xe648fe(0xb6)]?_0x4dfd3f:_0x152369,_0x3c2e92=_0x72f00e=>{var _0xece30=_0xe648fe;let _0x1135de={};return _0x1135de[_0xece30(0x11c)]=_0x72f00e[_0xece30(0x11c)],_0x1135de[_0xece30(0xef)]=_0x72f00e['elements'],_0x1135de[_0xece30(0x184)]=_0x72f00e['strLength'],_0x1135de[_0xece30(0xf6)]=_0x72f00e['totalStrLength'],_0x1135de['autoExpandLimit']=_0x72f00e[_0xece30(0xd3)],_0x1135de[_0xece30(0x10f)]=_0x72f00e[_0xece30(0x10f)],_0x1135de['sortProps']=!0x1,_0x1135de[_0xece30(0xda)]=!_0x388b73,_0x1135de['depth']=0x1,_0x1135de[_0xece30(0x185)]=0x0,_0x1135de[_0xece30(0xc1)]=_0xece30(0xe1),_0x1135de[_0xece30(0x162)]=_0xece30(0x169),_0x1135de[_0xece30(0xfc)]=!0x0,_0x1135de['autoExpandPreviousObjects']=[],_0x1135de[_0xece30(0xcf)]=0x0,_0x1135de[_0xece30(0xc5)]=!0x0,_0x1135de[_0xece30(0x171)]=0x0,_0x1135de[_0xece30(0x137)]={'current':void 0x0,'parent':void 0x0,'index':0x0},_0x1135de;};for(var _0x1e7497=0x0;_0x1e7497<_0x12aeb8['length'];_0x1e7497++)_0x154ff5[_0xe648fe(0x119)](_0x15deba[_0xe648fe(0xe8)]({'timeNode':_0x2f3fcb===_0xe648fe(0xd7)||void 0x0},_0x12aeb8[_0x1e7497],_0x3c2e92(_0x2e3311),{}));if(_0x2f3fcb===_0xe648fe(0x11f)){let _0x33ed06=Error['stackTraceLimit'];try{Error[_0xe648fe(0xaf)]=0x1/0x0,_0x154ff5[_0xe648fe(0x119)](_0x15deba[_0xe648fe(0xe8)]({'stackNode':!0x0},new Error()[_0xe648fe(0x16a)],_0x3c2e92(_0x2e3311),{'strLength':0x1/0x0}));}finally{Error['stackTraceLimit']=_0x33ed06;}}return{'method':_0xe648fe(0x179),'version':_0x3acc10,'args':[{'ts':_0x532f85,'session':_0x6fafaf,'args':_0x154ff5,'id':_0x18c1e8,'context':_0x3fcc97}]};}catch(_0x199939){return{'method':'log','version':_0x3acc10,'args':[{'ts':_0x532f85,'session':_0x6fafaf,'args':[{'type':_0xe648fe(0xc9),'error':_0x199939&&_0x199939['message']}],'id':_0x18c1e8,'context':_0x3fcc97}]};}finally{try{if(_0x55e646&&_0x26210e){let _0xe44928=_0x148f6d();_0x55e646[_0xe648fe(0x14d)]++,_0x55e646[_0xe648fe(0xd7)]+=_0x25c041(_0x26210e,_0xe44928),_0x55e646['ts']=_0xe44928,_0x1bc0bf[_0xe648fe(0xe0)][_0xe648fe(0x14d)]++,_0x1bc0bf['hits'][_0xe648fe(0xd7)]+=_0x25c041(_0x26210e,_0xe44928),_0x1bc0bf[_0xe648fe(0xe0)]['ts']=_0xe44928,(_0x55e646[_0xe648fe(0x14d)]>0x32||_0x55e646['time']>0x64)&&(_0x55e646[_0xe648fe(0xb6)]=!0x0),(_0x1bc0bf[_0xe648fe(0xe0)][_0xe648fe(0x14d)]>0x3e8||_0x1bc0bf['hits'][_0xe648fe(0xd7)]>0x12c)&&(_0x1bc0bf['hits']['reduceLimits']=!0x0);}}catch{}}}return _0x138560;}((_0x424913,_0x5f1dd1,_0x4f7b0c,_0x32c73f,_0x36c922,_0x3c8ea9,_0x41de49,_0x3a3377,_0x1b7b05,_0x164082,_0x41202b)=>{var _0x142ec4=_0x100f6d;if(_0x424913[_0x142ec4(0x181)])return _0x424913['_console_ninja'];if(!X(_0x424913,_0x3a3377,_0x36c922))return _0x424913[_0x142ec4(0x181)]={'consoleLog':()=>{},'consoleTrace':()=>{},'consoleTime':()=>{},'consoleTimeEnd':()=>{},'autoLog':()=>{},'autoLogMany':()=>{},'autoTraceMany':()=>{},'coverage':()=>{},'autoTrace':()=>{},'autoTime':()=>{},'autoTimeEnd':()=>{}},_0x424913[_0x142ec4(0x181)];let _0x3b2c7c=b(_0x424913),_0x4b8e24=_0x3b2c7c['elapsed'],_0x438d72=_0x3b2c7c[_0x142ec4(0x146)],_0x3a7ca6=_0x3b2c7c[_0x142ec4(0xe9)],_0x413926={'hits':{},'ts':{}},_0x506b15=H(_0x424913,_0x1b7b05,_0x413926,_0x3c8ea9),_0x468cb3=_0x6b2fb9=>{_0x413926['ts'][_0x6b2fb9]=_0x438d72();},_0x56fc34=(_0x3a84a9,_0x58a4ac)=>{var _0x1d0756=_0x142ec4;let _0x266417=_0x413926['ts'][_0x58a4ac];if(delete _0x413926['ts'][_0x58a4ac],_0x266417){let _0x16f46c=_0x4b8e24(_0x266417,_0x438d72());_0x493cf4(_0x506b15(_0x1d0756(0xd7),_0x3a84a9,_0x3a7ca6(),_0x2d06aa,[_0x16f46c],_0x58a4ac));}},_0x279b60=_0x526d53=>(_0x36c922===_0x142ec4(0x170)&&_0x424913['origin']&&_0x526d53?.['args']?.[_0x142ec4(0x110)]&&(_0x526d53['args'][0x0][_0x142ec4(0x99)]=_0x424913[_0x142ec4(0x99)]),_0x526d53);_0x424913[_0x142ec4(0x181)]={'consoleLog':(_0x1127ad,_0x388b26)=>{var _0x4f28fe=_0x142ec4;_0x424913[_0x4f28fe(0x121)][_0x4f28fe(0x179)][_0x4f28fe(0x118)]!=='disabledLog'&&_0x493cf4(_0x506b15(_0x4f28fe(0x179),_0x1127ad,_0x3a7ca6(),_0x2d06aa,_0x388b26));},'consoleTrace':(_0x4664d1,_0x327162)=>{var _0x26ef2c=_0x142ec4;_0x424913[_0x26ef2c(0x121)][_0x26ef2c(0x179)][_0x26ef2c(0x118)]!==_0x26ef2c(0x12f)&&_0x493cf4(_0x279b60(_0x506b15(_0x26ef2c(0x11f),_0x4664d1,_0x3a7ca6(),_0x2d06aa,_0x327162)));},'consoleTime':_0x56d9a6=>{_0x468cb3(_0x56d9a6);},'consoleTimeEnd':(_0x170de0,_0x360af0)=>{_0x56fc34(_0x360af0,_0x170de0);},'autoLog':(_0x384a5e,_0xf744a4)=>{var _0x5b45b1=_0x142ec4;_0x493cf4(_0x506b15(_0x5b45b1(0x179),_0xf744a4,_0x3a7ca6(),_0x2d06aa,[_0x384a5e]));},'autoLogMany':(_0x499ed0,_0x128742)=>{var _0x2755c7=_0x142ec4;_0x493cf4(_0x506b15(_0x2755c7(0x179),_0x499ed0,_0x3a7ca6(),_0x2d06aa,_0x128742));},'autoTrace':(_0x29cd32,_0x44208b)=>{var _0x60f0c9=_0x142ec4;_0x493cf4(_0x279b60(_0x506b15(_0x60f0c9(0x11f),_0x44208b,_0x3a7ca6(),_0x2d06aa,[_0x29cd32])));},'autoTraceMany':(_0x3a4709,_0x3b6ffe)=>{var _0x2b7603=_0x142ec4;_0x493cf4(_0x279b60(_0x506b15(_0x2b7603(0x11f),_0x3a4709,_0x3a7ca6(),_0x2d06aa,_0x3b6ffe)));},'autoTime':(_0x50c84b,_0x5d4759,_0x4b7e0f)=>{_0x468cb3(_0x4b7e0f);},'autoTimeEnd':(_0x124726,_0x5a49f2,_0xdf3f90)=>{_0x56fc34(_0x5a49f2,_0xdf3f90);},'coverage':_0x4f1a20=>{_0x493cf4({'method':'coverage','version':_0x3c8ea9,'args':[{'id':_0x4f1a20}]});}};let _0x493cf4=q(_0x424913,_0x5f1dd1,_0x4f7b0c,_0x32c73f,_0x36c922,_0x164082,_0x41202b),_0x2d06aa=_0x424913[_0x142ec4(0x176)];return _0x424913[_0x142ec4(0x181)];})(globalThis,_0x100f6d(0x93),_0x100f6d(0x183),_0x100f6d(0x13e),_0x100f6d(0x175),'1.0.0','1715180529239',_0x100f6d(0x126),_0x100f6d(0x10a),'','1');");}catch(e){}};/* istanbul ignore next */function oo_oo(i,...v){try{oo_cm().consoleLog(i, v);}catch(e){} return v};/* istanbul ignore next */function oo_tr(i,...v){try{oo_cm().consoleTrace(i, v);}catch(e){} return v};/* istanbul ignore next */function oo_ts(v){try{oo_cm().consoleTime(v);}catch(e){} return v;};/* istanbul ignore next */function oo_te(v, i){try{oo_cm().consoleTimeEnd(v, i);}catch(e){} return v;};/*eslint unicorn/no-abusive-eslint-disable:,eslint-comments/disable-enable-pair:,eslint-comments/no-unlimited-disable:,eslint-comments/no-aggregating-enable:,eslint-comments/no-duplicate-disable:,eslint-comments/no-unused-disable:,eslint-comments/no-unused-enable:,*/