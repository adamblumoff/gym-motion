import { NextResponse } from "next/server";

import { checkForFirmwareUpdate } from "@/lib/repository";
import {
  createPresignedReadUrl,
  hasBucketConfig,
  isExternalAssetUrl,
} from "@/lib/storage-bucket";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId");
  const firmwareVersion = searchParams.get("firmwareVersion");

  if (!deviceId) {
    return NextResponse.json(
      { ok: false, error: "deviceId is required." },
      { status: 400 },
    );
  }

  try {
    const result = await checkForFirmwareUpdate({
      deviceId,
      firmwareVersion,
    });
    const resolvedAssetUrl =
      result.release && hasBucketConfig() && !isExternalAssetUrl(result.release.assetUrl)
        ? await createPresignedReadUrl(result.release.assetUrl)
        : result.release?.assetUrl ?? null;

    return NextResponse.json(
      {
        ok: true,
        updateAvailable: result.updateAvailable,
        device: result.device,
        release: result.release,
        version: result.release?.version ?? null,
        assetUrl: resolvedAssetUrl,
        sha256: result.release?.sha256 ?? null,
        md5: result.release?.md5 ?? null,
        sizeBytes: result.release?.sizeBytes ?? null,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Failed to check firmware updates", error);

    return NextResponse.json(
      { ok: false, error: "Failed to check firmware updates." },
      { status: 500 },
    );
  }
}
