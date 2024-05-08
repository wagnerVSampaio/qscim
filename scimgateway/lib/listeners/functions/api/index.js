async function useKafkaListener(config, auth, endpointMapper, map) {
  //   const kafka = new Kafka({
  //     clientId: config.client_id,
  //     brokers: [config.url],
  //     sasl: {
  //       username: config.auth.username,
  //       password: config.auth.password,
  //       mechanism: config.auth.mechanism,
  //     },
  //     ssl: true,
  //   });

  const filteredAuth = auth.basic.filter((item) => !item.readOnly)[0];

  if (!filteredAuth) {
    console.error("No Basic Auth provided for Rest API listener");
  }

  const token = Buffer.from(
    `${filteredAuth.username}:${filteredAuth.password}`
  ).toString("base64");

  async function handleMessages() {
    // create consumer with timeout
    await consumer.subscribe({ topic: config.topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          body = JSON.parse(message.value.toString());

          if (config.mapping && Object.keys(config.mapping).length) {
            body = await endpointMapper(
              "inbound",
              JSON.parse(message.value.toString()),
              config.mapping
            ).then((res) => res[0]);
          }

          const response = await fetch(
            `http://localhost:${config.port}/${config.path}/${body.userName}`,
            {
              method: "GET",
              headers: {
                Authorization: `Basic ${token}`,
              },
            }
          );

          let url = `http://localhost:${config.port}/${config.path}`;
          let method = "POST";
          if (response.ok) {
            console.log(`${config.path} Already exist! Updating...`);
            url += `/${body.userName}`;
            method = "PATCH";
          } else {
            console.log(`${config.path} Already does not exist! Creating...`);
          }

          await fetch(url, {
            method: method,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${token}`,
            },
            body: JSON.stringify(body),
          });
        } catch (err) {
          console.log(`Error while doing request: ${err.message}`);
        }
      },
    });
  }
  handleMessages();
}

module.exports = { useKafkaListener };
