import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { VietnameseLocalizationRuntime } from "./ui/VietnameseLocalizationRuntime";

export default function App() {
  return (
    <VietnameseLocalizationRuntime>
      <RouterProvider router={router} />
    </VietnameseLocalizationRuntime>
  );
}
