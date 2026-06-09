import { createRoot } from "react-dom/client";

import "@/ui/styles.css";
import "@/ui/components/surface.css";
import { OnboardingApp } from "@/ui/onboarding/OnboardingApp";

const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(<OnboardingApp />);
}
