import { lazy, Suspense, useEffect, useState } from "react";
import { motion } from "@morrow/design-system";
import { BootSequence } from "./boot/BootSequence";
import { Environment } from "./environment/Environment";
import { initialize, useMorrow } from "./runtime/store";
import { Shell } from "./shell/Shell";

/**
 * Design previews of screens whose architecture does not exist yet. Development builds
 * only: in a production build `import.meta.env.DEV` is false, so this import is removed.
 */
const AuthPreview = import.meta.env.DEV ? lazy(() => import("./preview/AuthPreview").then((m) => ({ default: m.AuthPreview }))) : null;
const preview = typeof location !== "undefined" ? location.hash : "";

export function App() {
  if (AuthPreview && preview === "#preview/auth") {
    return (
      <>
        <Environment />
        <Suspense fallback={null}>
          <AuthPreview />
        </Suspense>
      </>
    );
  }
  return <MorrowApp />;
}

function MorrowApp() {
  const bootDismissed = useMorrow((s) => s.boot.dismissed);
  const [bootMounted, setBootMounted] = useState(true);

  useEffect(() => {
    void initialize();
  }, []);

  // Keep the boot layer mounted for its fade-out, then remove it.
  useEffect(() => {
    if (!bootDismissed) return;
    const id = setTimeout(() => setBootMounted(false), motion.MEDIUM.durationMs + 50);
    return () => clearTimeout(id);
  }, [bootDismissed]);

  return (
    <>
      <Environment />
      {bootDismissed ? <Shell /> : null}
      {bootMounted ? <BootSequence /> : null}
    </>
  );
}
