/** Discord 10003 means the destination no longer exists; transient failures must retry. */
export function isUnknownDiscordChannelError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    String((error as { code?: unknown }).code) === "10003";
}
