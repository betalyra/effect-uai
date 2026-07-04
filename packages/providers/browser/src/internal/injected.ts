/**
 * The page agent: the code that runs INSIDE the browser page.
 *
 * Everything lives in one self-contained function, {@link installPageAgent},
 * which is serialized with `Function.prototype.toString` and shipped through
 * `Runtime.evaluate` (the lowest-common-denominator CDP method, so it works
 * against partial CDP servers like obscura). It installs an idempotent
 * global (`globalThis.__effectUaiPageAgent`) holding the helpers the session
 * verbs call. Arguments cross the wire as `JSON.stringify` values, never as
 * interpolated code, so there is no escaping surface.
 *
 * Rules for code inside `installPageAgent`:
 * - Self-contained: no captures of module scope, no imports. Types are fine
 *   (they erase); values are not.
 * - Helpers signal failure by throwing `Error` with a descriptive message;
 *   the host surfaces it via `exceptionDetails`. The exception is
 *   `waitForSelector`, which reports timeout as `false` so the host can
 *   raise a typed `BrowserTimeout` instead of an action failure.
 *
 * The whole in-page world (including the ref registry) is reset by every
 * navigation, which is exactly the documented lifetime of element refs.
 */

import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Wire shapes. Values crossing page -> host are untrusted JSON; the host
// decodes them with these schemas instead of casting. The derived types
// double as the agent's own annotations (types erase, so serialization
// stays self-contained).
// ---------------------------------------------------------------------------

/** Viewport-relative center of an element, for `Input.dispatch*` events. */
export const InjectedPoint = Schema.Struct({ x: Schema.Number, y: Schema.Number })
export type InjectedPoint = typeof InjectedPoint.Type

/** Element box: viewport-relative from `query`, page coords from `pageBox`. */
export const InjectedBox = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})
export type InjectedBox = typeof InjectedBox.Type

export const InjectedSize = Schema.Struct({ width: Schema.Number, height: Schema.Number })
export type InjectedSize = typeof InjectedSize.Type

/** Element data returned by `query`; serializable, never a live handle. */
export const InjectedElementInfo = Schema.Struct({
  ref: Schema.String,
  tag: Schema.String,
  text: Schema.String,
  attributes: Schema.Record(Schema.String, Schema.String),
  box: InjectedBox,
})
export type InjectedElementInfo = typeof InjectedElementInfo.Type

/** The surface installed on `globalThis.__effectUaiPageAgent`. */
export type PageAgentApi = {
  readonly query: (selector: string, limit: number) => Array<InjectedElementInfo>
  readonly targetPoint: (selector: string) => InjectedPoint
  readonly pageBox: (selector: string) => InjectedBox
  readonly contentSize: () => InjectedSize
  readonly fill: (selector: string, text: string) => void
  readonly selectValue: (selector: string, value: string) => void
  readonly isChecked: (selector: string) => boolean
  readonly focusEl: (selector: string) => void
  readonly scrollBy: (direction: "up" | "down" | "left" | "right", pixels: number) => void
  readonly scrollIntoView: (selector: string) => void
  readonly waitForSelector: (selector: string, timeoutMs: number) => Promise<boolean>
  readonly html: () => string
  readonly markdown: () => string
  readonly readyState: () => string
}

const AGENT_GLOBAL = "__effectUaiPageAgent"

const installPageAgent = (): void => {
  const holder = globalThis as Record<string, unknown>
  // Global name must match AGENT_GLOBAL; duplicated because this function
  // is serialized and cannot capture module scope.
  if (holder["__effectUaiPageAgent"] !== undefined) return

  // -- ref registry: `@e1`-style refs minted by `query`, valid until the
  // -- next navigation (a navigation resets this whole world).
  const byRef = new Map<string, Element>()
  const refOf = new WeakMap<Element, string>()
  let refCounter = 0

  const refFor = (el: Element): string => {
    const existing = refOf.get(el)
    if (existing !== undefined) return existing
    refCounter += 1
    const ref = `@e${refCounter}`
    byRef.set(ref, el)
    refOf.set(el, ref)
    return ref
  }

  const mustResolve = (selector: string): Element => {
    if (selector.startsWith("@")) {
      const el = byRef.get(selector)
      if (el === undefined)
        throw new Error(`stale or unknown ref ${selector} (refs reset on navigation)`)
      if (!el.isConnected) throw new Error(`ref ${selector} is no longer in the document`)
      return el
    }
    const el = document.querySelector(selector)
    if (el === null) throw new Error(`no element matches selector ${selector}`)
    return el
  }

  // -- markdown serialization ------------------------------------------------

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "SVG", "HEAD"])

  const isHidden = (el: Element): boolean =>
    el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true"

  const collapse = (text: string): string => text.replace(/\s+/g, " ").trim()

  const inlineText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ")
    if (!(node instanceof Element)) return ""
    const tag = node.tagName.toUpperCase()
    if (SKIP.has(tag) || isHidden(node)) return ""
    const kids = (): string => Array.from(node.childNodes).map(inlineText).join("")
    if (tag === "BR") return "\n"
    if (tag === "STRONG" || tag === "B") {
      const t = collapse(kids())
      return t === "" ? "" : `**${t}**`
    }
    if (tag === "EM" || tag === "I") {
      const t = collapse(kids())
      return t === "" ? "" : `*${t}*`
    }
    if (tag === "CODE") {
      const t = collapse(node.textContent ?? "")
      return t === "" ? "" : `\`${t}\``
    }
    if (tag === "A") {
      const t = collapse(kids())
      if (t === "") return ""
      const href = node.getAttribute("href")
      return href === null || href.startsWith("javascript:") ? t : `[${t}](${href})`
    }
    if (tag === "IMG") {
      const src = node.getAttribute("src")
      return src === null ? "" : `![${node.getAttribute("alt") ?? ""}](${src})`
    }
    return kids()
  }

  const renderList = (el: Element, depth: number): string => {
    const ordered = el.tagName.toUpperCase() === "OL"
    const items: Array<string> = []
    let index = 0
    for (const li of Array.from(el.children)) {
      if (li.tagName.toUpperCase() !== "LI") continue
      index += 1
      let own = ""
      const sublists: Array<Element> = []
      for (const child of Array.from(li.childNodes)) {
        const childTag = child instanceof Element ? child.tagName.toUpperCase() : ""
        if (childTag === "UL" || childTag === "OL") sublists.push(child as Element)
        else own += inlineText(child)
      }
      let line = "  ".repeat(depth) + (ordered ? `${index}. ` : "- ") + collapse(own)
      for (const sub of sublists) line += "\n" + renderList(sub, depth + 1)
      items.push(line)
    }
    return items.join("\n")
  }

  const renderTable = (el: Element): string => {
    const rows = Array.from(el.querySelectorAll("tr"))
    const first = rows[0]
    if (first === undefined) return ""
    const cells = (tr: Element): Array<string> =>
      Array.from(tr.children)
        .filter((c) => c.tagName.toUpperCase() === "TD" || c.tagName.toUpperCase() === "TH")
        .map((c) => collapse(inlineText(c)) || " ")
    const lines = rows.map((tr) => `| ${cells(tr).join(" | ")} |`)
    const separator = `| ${cells(first)
      .map(() => "---")
      .join(" | ")} |`
    return [lines[0], separator, ...lines.slice(1)].join("\n")
  }

  const walkBlocks = (el: Element, out: Array<string>): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toUpperCase()
      if (SKIP.has(tag) || isHidden(child)) continue
      const heading = /^H([1-6])$/.exec(tag)
      if (heading !== null) {
        const t = collapse(inlineText(child))
        if (t !== "") out.push("#".repeat(Number(heading[1] ?? "1")) + " " + t)
        continue
      }
      if (tag === "P") {
        const t = collapse(inlineText(child))
        if (t !== "") out.push(t)
        continue
      }
      if (tag === "PRE") {
        out.push("```\n" + (child.textContent ?? "").replace(/\s+$/, "") + "\n```")
        continue
      }
      if (tag === "BLOCKQUOTE") {
        const t = collapse(inlineText(child))
        if (t !== "") out.push("> " + t)
        continue
      }
      if (tag === "UL" || tag === "OL") {
        const t = renderList(child, 0)
        if (t !== "") out.push(t)
        continue
      }
      if (tag === "TABLE") {
        const t = renderTable(child)
        if (t !== "") out.push(t)
        continue
      }
      if (tag === "HR") {
        out.push("---")
        continue
      }
      if (child.children.length > 0) {
        walkBlocks(child, out)
        continue
      }
      const t = collapse(inlineText(child))
      if (t !== "") out.push(t)
    }
  }

  // -- the agent surface -----------------------------------------------------

  const agent: PageAgentApi = {
    query: (selector, limit) => {
      const els = selector.startsWith("@")
        ? [mustResolve(selector)]
        : Array.from(document.querySelectorAll(selector))
      return els.slice(0, limit).map((el) => {
        const rect = el.getBoundingClientRect()
        const attributes: Record<string, string> = {}
        for (const attr of Array.from(el.attributes)) attributes[attr.name] = attr.value
        return {
          ref: refFor(el),
          tag: el.tagName.toLowerCase(),
          text: collapse(el.textContent ?? "").slice(0, 200),
          attributes,
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      })
    },

    targetPoint: (selector) => {
      const el = mustResolve(selector)
      el.scrollIntoView({ block: "center", inline: "center" })
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        throw new Error(`element ${selector} has no visible box`)
      }
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    },

    pageBox: (selector) => {
      const rect = mustResolve(selector).getBoundingClientRect()
      return {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      }
    },

    contentSize: () => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }),

    fill: (selector, text) => {
      const el = mustResolve(selector)
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        // Set through the native prototype setter so framework value
        // trackers (React et al.) see the change, then fire the events a
        // real keyboard session would.
        const proto =
          el instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : HTMLTextAreaElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
        el.focus()
        if (setter !== undefined) setter.call(el, text)
        else el.value = text
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return
      }
      if (el instanceof HTMLElement && el.isContentEditable) {
        el.focus()
        el.textContent = text
        el.dispatchEvent(new Event("input", { bubbles: true }))
        return
      }
      throw new Error(`element ${selector} is not fillable (input, textarea, or contenteditable)`)
    },

    selectValue: (selector, value) => {
      const el = mustResolve(selector)
      if (!(el instanceof HTMLSelectElement)) {
        throw new Error(`element ${selector} is not a <select>`)
      }
      const option = Array.from(el.options).find((o) => o.value === value)
      if (option === undefined) {
        throw new Error(`select ${selector} has no option with value ${JSON.stringify(value)}`)
      }
      el.value = value
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
    },

    isChecked: (selector) => {
      const el = mustResolve(selector)
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        return el.checked
      }
      throw new Error(`element ${selector} is not a checkbox or radio input`)
    },

    focusEl: (selector) => {
      const el = mustResolve(selector)
      if (!(el instanceof HTMLElement)) throw new Error(`element ${selector} is not focusable`)
      el.focus()
    },

    scrollBy: (direction, pixels) => {
      const [dx, dy] =
        direction === "up"
          ? [0, -pixels]
          : direction === "down"
            ? [0, pixels]
            : direction === "left"
              ? [-pixels, 0]
              : [pixels, 0]
      window.scrollBy({ left: dx, top: dy, behavior: "instant" })
    },

    scrollIntoView: (selector) => {
      mustResolve(selector).scrollIntoView({ block: "center", inline: "center" })
    },

    waitForSelector: (selector, timeoutMs) =>
      new Promise((resolve) => {
        const found = (): boolean =>
          selector.startsWith("@")
            ? (byRef.get(selector)?.isConnected ?? false)
            : document.querySelector(selector) !== null
        if (found()) return resolve(true)
        const observer = new MutationObserver(() => {
          if (!found()) return
          observer.disconnect()
          window.clearTimeout(timer)
          resolve(true)
        })
        const timer = window.setTimeout(() => {
          observer.disconnect()
          resolve(false)
        }, timeoutMs)
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        })
      }),

    html: () => document.documentElement.outerHTML,

    markdown: () => {
      const out: Array<string> = []
      const title = document.title.trim()
      if (title !== "") out.push(`# ${title}`)
      // Prefer the primary content region so the serialization leads with the
      // article, not a site-wide nav/sidebar (which in DOM order often comes
      // first and would otherwise dominate a truncated view).
      const root = document.querySelector("main, [role=main], article") ?? document.body
      if (root !== null) walkBlocks(root, out)
      return out.join("\n\n")
    },

    readyState: () => document.readyState,
  }

  holder["__effectUaiPageAgent"] = agent
}

/**
 * Build the `Runtime.evaluate` expression for one agent call: install the
 * agent (idempotent) and invoke the named helper. Arguments are embedded via
 * `JSON.stringify`, so user input never becomes code.
 *
 * The whole thing is one IIFE that `return`s the helper result, so the
 * expression has a single, well-defined completion value. A bare sequence of
 * `;`-separated statements would leave the completion value engine-dependent
 * (obscura's `Runtime.evaluate` yields `undefined` for it), and a returned
 * promise still resolves correctly under `awaitPromise`.
 */
export const agentExpression = (fn: keyof PageAgentApi, args: ReadonlyArray<unknown>): string =>
  `(()=>{(${installPageAgent.toString()})();return globalThis.${AGENT_GLOBAL}.${fn}(${args
    .map((a) => JSON.stringify(a))
    .join(",")});})()`
