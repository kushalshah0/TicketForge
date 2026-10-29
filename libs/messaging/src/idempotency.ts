import type { DrizzleTransaction } from '@tf/common';
import { processedMessages } from './schema';

export async function runOnce<T>(
  transaction: DrizzleTransaction,
  messageId: string,
  consumer: string,
  handler: (transaction: DrizzleTransaction) => Promise<T>,
): Promise<boolean> {
  const result = await transaction
    .insert(processedMessages)
    .values({ messageId, consumer })
    .onConflictDoNothing()
    .returning({ messageId: processedMessages.messageId });

  if (result.length === 0) return false;
  await handler(transaction);
  return true;
}
