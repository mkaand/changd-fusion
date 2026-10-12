import { HttpError, type CaptureTimings } from "./errors.js";
export class AttentionFailure extends HttpError {
  timings?: CaptureTimings;
  constructor(
    public state: "authentication_required" | "challenge_detected",
    public confidence: "confirmed" | "heuristic",
    message: string,
  ) {
    super(422, message);
  }
}
export function detectAttention(
  status: number,
  path: string,
  title: string,
  hasPassword: boolean,
  challengeMarker: boolean,
) {
  if (status === 401)
    return new AttentionFailure(
      "authentication_required",
      "confirmed",
      "Authentication required (HTTP 401). Update the workflow or private values.",
    );
  if (
    challengeMarker ||
    /just a moment|verify you are human|checking your browser|^captcha(?: verification| challenge)?$/i.test(
      title,
    )
  )
    return new AttentionFailure(
      "challenge_detected",
      "heuristic",
      "Possible browser challenge detected. Manual attention is required; no challenge solving is attempted.",
    );
  if (status === 403)
    return new HttpError(
      422,
      "Access denied (HTTP 403). This does not confirm a CAPTCHA.",
    );
  if (hasPassword && /(?:^|\/)login|sign[-_]?in|authenticate/i.test(path))
    return new AttentionFailure(
      "authentication_required",
      "heuristic",
      "Possible login screen detected. Update the workflow or private values.",
    );
  return null;
}
