import { CopyOutlined, ExportOutlined } from "@ant-design/icons";
import { Button, Space } from "antd";

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

async function copy(value: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  try {
    if (!document.execCommand("copy")) throw Error("Clipboard unavailable");
  } finally { input.remove(); }
}

export function MonitorUrlActions({ url, message, compact = false }: { url: string; message: { success: (value: string) => unknown; error: (value: string) => unknown }; compact?: boolean }) {
  const target = safeHttpUrl(url);
  return <Space size={compact ? 2 : 4} className="monitor-url-actions">
    <Button type="text" size="small" icon={<CopyOutlined />} aria-label="Copy monitor URL" title="Copy monitor URL" onClick={() => void copy(url).then(() => message.success("URL copied")).catch(() => message.error("Could not copy the URL"))} />
    {target ? <a className="monitor-url-open" href={target} target="_blank" rel="noopener noreferrer" aria-label="Open monitored website in new tab" title="Open monitored website in new tab"><ExportOutlined /></a> : <Button type="text" size="small" disabled icon={<ExportOutlined />} aria-label="Open monitored website in new tab" title="Only HTTP and HTTPS URLs can be opened" />}
  </Space>;
}
