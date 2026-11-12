import type { ApiDocumentData } from "@canvas/api-document";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** What the side column shows that a link can open: a source anchor. */
export type OpenLink = { anchorId: string } | null;

export const openLinkKey = new PluginKey<OpenLink>("openLink");

/**
 * Washes the links whose target the side column shows, as the document's
 * links did. Set the target with a transaction's `openLinkKey` meta.
 */
export function openLinks(data: () => ApiDocumentData): Plugin<OpenLink> {
  return new Plugin<OpenLink>({
    key: openLinkKey,
    state: {
      init: () => null,
      apply: (tr, value) => {
        const next: OpenLink | undefined = tr.getMeta(openLinkKey);

        return next === undefined ? value : next;
      },
    },
    props: {
      decorations(state) {
        const open = openLinkKey.getState(state);

        if (!open) return null;
        const { anchors } = data();
        const washed: Decoration[] = [];

        const opens = (blockId: string, href: string) =>
          anchors.get(`${blockId}:${href}`)?.id === open.anchorId;

        state.doc.forEach((block, offset) => {
          block.descendants((node, pos) => {
            const link = node.marks.find((mark) => mark.type.name === "link");

            if (
              !node.isText ||
              !link ||
              !opens(block.attrs.id, link.attrs.href)
            )
              return;
            const from = offset + 1 + pos;

            washed.push(
              Decoration.inline(from, from + node.nodeSize, {
                class: "review-board-link-open",
                "data-review-anchor-open": "true",
              }),
            );
          });
        });

        return DecorationSet.create(state.doc, washed);
      },
    },
  });
}
