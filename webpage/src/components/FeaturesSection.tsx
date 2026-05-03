import type { IconType } from "react-icons";
import {
  PiBackpack,
  PiClipboardText,
  PiPuzzlePiece,
  PiSlidersHorizontal,
  PiSquaresFour,
  PiTag,
  PiWaves,
} from "react-icons/pi";
import ReactMarkdown, { type Components } from "react-markdown";

import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Feature {
  readonly title: string;
  readonly description: string;
  readonly Icon: IconType;
}

const features: ReadonlyArray<Feature> = [
  {
    title: "Explicit control",
    description:
      "No black-box magic. You stay in **full control** of your agent loop.",
    Icon: PiSlidersHorizontal,
  },
  {
    title: "Built on Effect",
    description:
      "**Retries**, **streams**, **concurrency**, **errors** — handled by Effect, not reinvented.",
    Icon: PiPuzzlePiece,
  },
  {
    title: "Powerful building blocks",
    description:
      "Small, composable primitives to assemble your own **agentic loops**.",
    Icon: PiSquaresFour,
  },
  {
    title: "Recipes for the hard parts",
    description:
      "Copy-paste solutions for **model council**, **auto-compaction**, **pause and resume**, and more.",
    Icon: PiClipboardText,
  },
  {
    title: "Streaming first",
    description:
      "Everything is a **stream** you can **transform**, **filter**, and **collect** when ready. Performance built in.",
    Icon: PiWaves,
  },
  {
    title: "Typed errors",
    description:
      "**Easy** and **type-safe** error handling. Match `RateLimited`, `Unavailable`, or `Timeout` directly, no string parsing.",
    Icon: PiTag,
  },
  {
    title: "Carry your own state",
    description:
      "**History**, **budget**, scratchpad — track whatever your agent needs. It's just a value.",
    Icon: PiBackpack,
  },
];

const markdownComponents: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>
  ),
};

export default function FeaturesSection() {
  return (
    <section className="not-content border-t border-border pt-8 pb-8 lg:pt-12 lg:pb-12">
      <h2
        style={{ marginBottom: "2rem" }}
        className="text-3xl font-bold tracking-tight text-foreground"
      >
        Features
      </h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
        {features.map(({ title, description, Icon }) => (
          <Card
            key={title}
            className="group h-full gap-3 rounded-[14px] border-border bg-card py-6 shadow-none transition-colors hover:border-(--color-mark)"
          >
            <CardHeader className="gap-3 px-6">
              <div className="flex items-center gap-3">
                <div className="flex aspect-square h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-border text-foreground transition-colors group-hover:border-(--color-mark) group-hover:text-(--color-mark)">
                  <Icon className="h-4 w-4" />
                </div>
                <CardTitle className="text-base text-foreground transition-colors group-hover:text-(--color-mark)">
                  {title}
                </CardTitle>
              </div>
              <CardDescription className="text-sm leading-relaxed">
                <ReactMarkdown components={markdownComponents}>
                  {description}
                </ReactMarkdown>
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}
