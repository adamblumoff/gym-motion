const localDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatLocalTime(value: string | null) {
  if (!value) {
    return "Never";
  }

  return localDateTimeFormatter.format(new Date(value));
}
