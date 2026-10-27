import { useEffect, useState } from "react";
import { Alert } from "antd";
import { api } from "./api";

export function ManualRunStatus({ id, refresh }: { id: string; refresh: number }) {
  const [status, setStatus] = useState("idle");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () => void api(`/jobs/${id}/run`, "GET", undefined, { signal: controller.signal })
      .then((result) => { if (active) setStatus(result.status); }).catch(() => {});
    load();
    const timer = window.setInterval(load, 3000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [id, refresh]);
  if (status === "idle") return null;
  const text: Record<string, string> = {
    queued: "Check now queued. Browser checks wait for a safe interactive handoff.",
    running: "Check now running.",
    completed: "Check now completed. See monitoring history for the result.",
    failed: "Check now failed. See monitor diagnostics for the capture error.",
    cancelled: "Check now cancelled before capture started.",
  };
  return <Alert role="status" type={status === "failed" ? "warning" : "info"} title={text[status] ?? "Check now status is unavailable."} />;
}
