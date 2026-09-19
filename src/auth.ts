import { createHash, timingSafeEqual } from "node:crypto";

export function bearerOk(expectedToken: string, authorizationHeader: string | undefined): boolean {
  if (!authorizationHeader) return false;
  const space = authorizationHeader.indexOf(" ");
  if (space < 0) return false;
  if (authorizationHeader.slice(0, space).toLowerCase() !== "bearer") return false;
  const provided = authorizationHeader.slice(space + 1);
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}
