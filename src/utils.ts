const EMAIL_ADDRESS_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidAddress(address: string): boolean {
  if (typeof address !== "string" || address.length === 0) {
    return false;
  }
  if (address.length > 255) {
    return false;
  }
  return EMAIL_ADDRESS_REGEX.test(address);
}
