import { AletheiaMatterDashboard } from "@/aletheia/AletheiaMatterDashboard";
import { AletheiaShell } from "@/aletheia/AletheiaShell";

export default async function AletheiaMattersPage({
    searchParams,
}: {
    searchParams: Promise<{ newMatter?: string }>;
}) {
    const { newMatter } = await searchParams;

    return (
        <AletheiaShell>
            <AletheiaMatterDashboard initialNewMatterOpen={newMatter === "1"} />
        </AletheiaShell>
    );
}
