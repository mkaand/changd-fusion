import { createRoot } from "react-dom/client";
import { ConfigProvider, App } from "antd";
import "antd/dist/reset.css";
import FusionApp from "./App";
import { useThemeAdapter, themeConfig } from "./theme";
import "./style.css";
import "./allmy-theme-controls.css";
function ThemedApp() {
  const adapter = useThemeAdapter();
  return (
    <ConfigProvider theme={themeConfig(adapter.resolved)}>
      <App>
        <FusionApp />
      </App>
    </ConfigProvider>
  );
}
createRoot(document.getElementById("root")!).render(<ThemedApp />);
