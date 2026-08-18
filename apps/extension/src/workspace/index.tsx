import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceRoot } from "./WorkspaceRoot";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Workspace root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <WorkspaceRoot />
  </StrictMode>,
);
