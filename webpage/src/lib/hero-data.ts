export interface HeroAction {
  readonly text: string
  readonly link: string
  readonly variant: "primary" | "secondary" | "minimal"
  readonly icon?:
    | { readonly type: "icon"; readonly name: string }
    | { readonly type: "raw"; readonly html: string }
}

export interface DocsFrontmatter {
  readonly title: string
  readonly hero?: {
    readonly title?: string
    readonly tagline?: string
    readonly actions?: ReadonlyArray<HeroAction>
  }
}

export const docsData = (route: App.Locals["starlightRoute"]): DocsFrontmatter =>
  route.entry.data as unknown as DocsFrontmatter
