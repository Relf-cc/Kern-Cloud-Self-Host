/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// What the window shows before any server has been added.
//
// It is mostly instructions, on purpose: somebody opening this for the first
// time has a server somewhere and no idea what this app wants from them. The
// three steps are the whole path, and the third is the one that matters -
// a management API that only answers its own machine needs a tunnel, and
// saying so here saves a confusing failure later.

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BrandMark } from "@/app/BrandMark";
import { AddServer } from "./AddServer";

export function Welcome() {
  const [adding, setAdding] = useState(false);
  return (
    <div className="welcome">
      <div className="welcome__card">
        <BrandMark className="welcome__mark" size={56} />
        <h1>Kern Platform</h1>
        <p>
          The administrator&rsquo;s side of a self-hosted Kern server: who has an account, what they&rsquo;re syncing, whether anything needs
          attention, and the repairs for when it does.
        </p>

        <div className="welcome__steps">
          <div className="welcome__step">
            <span className="welcome__num">1</span>
            <span>
              <b>On the server</b>, run <code>kernctl pair</code>. It mints a management token for this app and prints one line to copy.
            </span>
          </div>
          <div className="welcome__step">
            <span className="welcome__num">2</span>
            <span>
              <b>If the server is another machine</b>, forward its port first — its management API answers only its own loopback until you
              change that: <code>ssh -L 8787:127.0.0.1:8787 you@server</code>
            </span>
          </div>
          <div className="welcome__step">
            <span className="welcome__num">3</span>
            <span>
              <b>Add it here</b> and paste the line. Kern Platform keeps the token in this computer&rsquo;s credential store, never in a file
              it writes.
            </span>
          </div>
        </div>

        <div className="row" style={{ justifyContent: "center" }}>
          <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
            Add a server
          </Button>
        </div>
      </div>
      {adding && <AddServer onClose={() => setAdding(false)} />}
    </div>
  );
}
