import { z } from 'zod';

export function loadConfig<TSchema extends z.ZodType>(
  schema: TSchema,
  env: NodeJS.ProcessEnv = process.env,
): z.output<TSchema> {
  const result = schema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const message =
          issue.code === 'invalid_type' && !('input' in issue)
            ? 'Required'
            : issue.message;
        return `${issue.path.join('.') || 'config'}: ${message}`;
      })
      .join('; ');

    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}
