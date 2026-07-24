export function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
export function errorHandler(err, req, res, next) {
  console.error(err);
  const status = err.status || 500;
  // Only surface messages we raised deliberately (4xx). For 5xx — Prisma/driver
  // errors, unexpected throws — never echo the internal text to the client (it
  // discloses schema/query detail); log it server-side and return a generic line.
  const message = status < 500 ? err.message || "Request failed" : "Internal server error";
  res.status(status).json({ message });
}
