import { connect } from 'amqplib';

const [queue, ...extraArgs] = process.argv.slice(2);
const queueNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

if (
  !queue ||
  extraArgs.length > 0 ||
  !queueNamePattern.test(queue) ||
  queue.endsWith('.dlq') ||
  queue.includes('.retry.')
) {
  throw new Error('Usage: npm run dlq:replay -- <main-queue-name>');
}

const amqpUrl = process.env.AMQP_URL;
if (!amqpUrl) throw new Error('Set AMQP_URL before replaying a dead-letter queue.');

const connection = await connect(amqpUrl);
let channel;

try {
  channel = await connection.createConfirmChannel();
  const deadLetterQueue = `${queue}.dlq`;
  const { messageCount } = await channel.checkQueue(deadLetterQueue);
  await channel.checkQueue(queue);

  let replayed = 0;
  for (let index = 0; index < messageCount; index += 1) {
    const message = await channel.get(deadLetterQueue, { noAck: false });
    if (!message) break;

    const headers = { ...message.properties.headers };
    delete headers['x-dlq-reason'];
    delete headers['x-death'];
    headers['x-attempt'] = 0;

    let unroutable;
    const onReturn = (returnedMessage) => {
      if (returnedMessage.fields.routingKey === queue) {
        unroutable = new Error(`Replay destination queue ${queue} rejected the message`);
      }
    };
    channel.on('return', onReturn);
    try {
      channel.sendToQueue(queue, message.content, {
        ...message.properties,
        persistent: true,
        mandatory: true,
        headers,
      });
      await channel.waitForConfirms();
    } finally {
      channel.removeListener('return', onReturn);
    }
    if (unroutable) throw unroutable;
    channel.ack(message);
    replayed += 1;
  }

  console.log(`Replayed ${replayed} message(s) from ${deadLetterQueue} to ${queue}.`);
} finally {
  try {
    await channel?.close();
  } finally {
    await connection.close();
  }
}
