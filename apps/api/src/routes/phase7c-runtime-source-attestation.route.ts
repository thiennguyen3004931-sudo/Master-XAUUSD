import { Router, type Request, type Response } from "express";
import { getPhase7CRuntimeSourceAttestationSnapshot } from "../services/phase7c-runtime-source-attestation.service";

const router = Router();

function isLoopbackRequest(req: Request): boolean {
  const addresses = [req.ip, req.socket.remoteAddress]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return addresses.some((value) =>
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1");
}

router.get("/", (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: "Runtime source attestation is restricted to localhost." });
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.json(getPhase7CRuntimeSourceAttestationSnapshot());
});

export default router;
