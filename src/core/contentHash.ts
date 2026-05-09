import { createHash } from 'node:crypto';

export function hashContent(content: string | Buffer): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return createHash('sha256').update(buffer).digest('hex');
}
