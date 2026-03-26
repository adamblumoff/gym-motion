import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "./ui/button";

type PageHeaderProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  backHref?: string;
  backLabel?: string;
  rightSlot?: ReactNode;
};

export function PageHeader({
  title,
  description,
  icon: Icon,
  backHref,
  backLabel = "Back",
  rightSlot,
}: PageHeaderProps) {
  const navigate = useNavigate();
  function handleBackClick() {
    if (!backHref) {
      return;
    }

    if (backHref.startsWith("/")) {
      window.location.hash = `#${backHref}`;
      window.location.reload();
      return;
    }

    navigate(backHref);
  }

  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-6 py-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {backHref ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="text-zinc-400 hover:text-zinc-100"
                onClick={handleBackClick}
              >
                <ArrowLeft className="size-4 mr-2" />
                {backLabel}
              </Button>
              <div className="w-px h-8 bg-zinc-800" />
            </>
          ) : null}
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 rounded-lg">
              <Icon className="size-6 text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-zinc-100">{title}</h1>
              <p className="text-sm text-zinc-500">{description}</p>
            </div>
          </div>
        </div>
        {rightSlot}
      </div>
    </div>
  );
}
