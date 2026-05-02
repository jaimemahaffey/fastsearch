export function isEligibleTextFile(relativePath: string, byteLength: number, maxFileSizeKb: number): boolean {
  if (relativePath.includes('/node_modules/') || relativePath.includes('\\node_modules\\')) {
    return false;
  }

  return byteLength <= maxFileSizeKb * 1024;
}
