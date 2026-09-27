import { useEffect, useState } from "react";
import { motion } from "@morrow/design-system";
import { BootSequence } from "./boot/BootSequence";
import { Environment } from "./environment/Environment";
import { initialize, useMorrow } from "./runtime/store";
import { Shell } from "./shell/Shell";

export function App() {
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
