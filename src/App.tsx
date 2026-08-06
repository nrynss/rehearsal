import { useEffect, useState } from "react";
import ResearchScreen from "./components/ResearchScreen";
import { ensureAnonSession } from "./lib/config";

export default function App() {
  // Gate the whole app on an anonymous session. If sign-in fails, the
  // research screen renders with the run button disabled and a plain message.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void ensureAnonSession().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!ready) return null;
  return <ResearchScreen />;
}
