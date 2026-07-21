export type ResolvedEditVersionArgs = {
    editId: string;
    documentId: string;
    status: "accepted" | "rejected";
    versionId: string | null;
    versionNumber?: number | null;
    downloadUrl: string | null;
};

type EditableTabShape = {
    kind?: string;
    documentId?: string;
    versionId?: string | null;
    versionNumber?: number | null;
    refetchKey?: number;
    edit?: {
        edit_id: string;
        status: "pending" | "accepted" | "rejected";
    };
};

export function applyResolvedEditVersionToTabs<T extends EditableTabShape>(
    tabs: T[],
    args: ResolvedEditVersionArgs,
): T[] {
    let changed = false;
    const nextTabs = tabs.map((tab) => {
        if (tab.kind === "case" || tab.documentId !== args.documentId) {
            return tab;
        }

        let next: T = tab;
        const patch = (values: Partial<T>) => {
            if (next === tab) next = { ...tab };
            next = { ...next, ...values };
            changed = true;
        };

        if (tab.versionId !== args.versionId) {
            patch({ versionId: args.versionId } as Partial<T>);
        }
        if (
            Object.prototype.hasOwnProperty.call(tab, "versionNumber") &&
            args.versionNumber !== undefined &&
            tab.versionNumber !== args.versionNumber
        ) {
            patch({ versionNumber: args.versionNumber } as Partial<T>);
        }
        if (Object.prototype.hasOwnProperty.call(tab, "refetchKey")) {
            patch({ refetchKey: (tab.refetchKey ?? 0) + 1 } as Partial<T>);
        }
        if (
            tab.edit?.edit_id === args.editId &&
            tab.edit.status !== args.status
        ) {
            patch({
                edit: { ...tab.edit, status: args.status },
            } as Partial<T>);
        }

        return next;
    });
    return changed ? nextTabs : tabs;
}
