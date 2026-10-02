const port = Number(process.env.PORT ?? 3000);

try {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid PORT");
  const response = await fetch(`http://127.0.0.1:${port}/ready`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (response.status !== 200) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
