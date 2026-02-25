export const ALLOWED_ORIGINS = [
  'https://pcompass.vercel.app',
];

export function getAllowedOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}
