import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
    metadataBase: new URL("https://aletheia.local"),
    title: "Aletheia",
    description: "Local legal workspace.",
    icons: {
        icon: [
            { url: "/icon.png", type: "image/png", sizes: "1024x1024" },
            { url: "/favicon.ico" },
        ],
        apple: "/apple-touch-icon.png",
    },
    openGraph: {
        type: "website",
        url: "https://aletheia.local",
        siteName: "Aletheia 明证",
        title: "Aletheia",
        description: "Local legal workspace.",
        images: [
            {
                url: "/link-image.jpg",
                width: 1200,
                height: 651,
                alt: "Aletheia 明证",
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title: "Aletheia",
        description: "Local legal workspace.",
        images: ["/link-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body className="font-sans antialiased">
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
