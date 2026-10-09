import { createRoot } from "react-dom/client";
import { ConfigProvider, App } from "antd";
import "antd/dist/reset.css";
import FusionApp from "./App";
import { fusionTheme } from "./theme";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <ConfigProvider theme={fusionTheme}>
    <App>
      <FusionApp />
    </App>
  </ConfigProvider>,
);
