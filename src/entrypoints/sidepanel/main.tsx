import { createRoot } from "react-dom/client";

import "@/ui/styles.css";
import "@/ui/components/surface.css";
import { SidePanelApp } from "@/ui/sidepanel/SidePanelApp";

const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(<SidePanelApp />);
}
