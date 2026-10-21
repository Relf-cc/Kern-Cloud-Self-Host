/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// A page that throws takes the page down, not the window. The server is still
// running; losing the interface to it should not look like losing the server.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Problem } from "@/components/ui/Controls";
import { Page, PageBody, PageHeader } from "./Page";

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary: used to clear it on a page change. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[kern-platform] a page failed", error, info.componentStack);
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Page>
        <PageHeader icon={CircleAlert} title="Something went wrong" />
        <PageBody narrow>
          <Problem title="This page stopped working" detail={error.message}>
            <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          </Problem>
        </PageBody>
      </Page>
    );
  }
}
