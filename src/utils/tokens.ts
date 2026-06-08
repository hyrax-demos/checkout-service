// Generate a token used for password-reset and email-confirmation links.
export function generateResetToken(): string {
  let token = "";
  const chars = "abcdef0123456789";
  for (let i = 0; i < 32; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}
