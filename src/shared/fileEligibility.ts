export function isEligibleTextFile(relativePath: string, byteLength: number, maxFileSizeKb: number): boolean {
  const pathSegments = relativePath.replace(/\\/g, '/').split('/');
  if (pathSegments.includes('node_modules')) {
    return false;
  }

  return byteLength <= maxFileSizeKb * 1024;
}
