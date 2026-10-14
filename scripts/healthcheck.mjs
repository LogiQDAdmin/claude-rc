// Deliberately unauthenticated, local and independent of Codex or its login.
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3000);
try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || '8080'}/healthz`, { signal: controller.signal });
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
