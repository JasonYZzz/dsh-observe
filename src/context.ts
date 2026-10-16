import { z } from 'zod';
export const idSchema = z.string().min(1).max(1024);
export const bindingSchema = z.object({
  sessionId: idSchema, requestId: idSchema.optional(), messageId: idSchema.optional(),
  userId: idSchema, tenantId: idSchema.optional(), agentDefinitionId: idSchema.optional(), agentVersion: idSchema.optional(), sourcePlugin: z.string().min(1).max(256),
}).strict().refine((value) => value.requestId || value.messageId, 'Request or message identity required');
