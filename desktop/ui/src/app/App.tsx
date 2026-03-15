import { RouterProvider } from "react-router";

import { DesktopRuntimeProvider, useDesktopRuntime } from "./runtime-context";
import { router } from "./routes";

function AppRouter() {
  const { isLoaded } = useDesktopRuntime();

  if (!isLoaded) {
    return (
      <div className="size-full min-h-screen flex items-center justify-center bg-black text-zinc-500">
        Loading Bluetooth dashboard...
      </div>
    );
  }

  return <RouterProvider router={router} />;
}

export default function App() {
  return (
    <DesktopRuntimeProvider>
      <AppRouter />
    </DesktopRuntimeProvider>
  );
}
