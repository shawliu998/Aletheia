import type { Metadata } from "next";
import { OfficeAuthGate } from "@/app/components/office/OfficeAuthGate";
import { WordTaskPane } from "@/app/components/office/WordTaskPane";

export const metadata: Metadata = {
    title: "Vera Word Review",
    description: "Review selected Word text with Vera.",
};

export default function WordAddInPage() {
    return (
        <OfficeAuthGate>
            <WordTaskPane />
        </OfficeAuthGate>
    );
}
