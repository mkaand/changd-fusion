import { createRoot } from "react-dom/client";
import { ConfigProvider, App } from "antd";
import "antd/dist/reset.css";
import FusionApp from "./App";
import { useThemeAdapter, themeConfig } from "./theme";
import { useEffect } from "react";
import "./style.css";
function ThemedApp() {
  const adapter = useThemeAdapter();
  useEffect(() => {
    document.documentElement.dataset.theme = adapter.resolved;
    document.documentElement.style.colorScheme = adapter.resolved;
  }, [adapter.resolved]);
  return (
    <ConfigProvider theme={themeConfig(adapter.resolved)}>
      <App>
        <FusionApp />
      </App>
    </ConfigProvider>
  );
}
createRoot(document.getElementById("root")!).render(<ThemedApp />);
