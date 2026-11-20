/** The changelog's resource filter: a select that hides the rows of other resources. */
export function initChangelogFilter(): void {
  const select = document.querySelector<HTMLSelectElement>('[data-area-filter]');
  const root = select?.closest('[data-changelog]');
  if (!select || !root) return;
  select.hidden = false;
  select.addEventListener('change', () => {
    for (const row of root.querySelectorAll<HTMLElement>('.cl-item'))
      row.hidden = select.value !== '' && row.dataset.area !== select.value;
    for (const day of root.querySelectorAll<HTMLElement>('.cl-day'))
      day.hidden = !day.querySelector('.cl-item:not([hidden])');
  });
}
