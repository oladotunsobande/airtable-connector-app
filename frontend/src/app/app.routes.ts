import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'data-grid', pathMatch: 'full' },
  {
    path: 'data-grid',
    loadComponent: () =>
      import('./features/data-grid/data-grid.component').then((m) => m.DataGridComponent),
  },
  {
    path: 'integrations',
    loadComponent: () =>
      import('./features/integrations/integrations.component').then((m) => m.IntegrationsComponent),
  },
  {
    path: 'scraping',
    loadComponent: () =>
      import('./features/scraping/scraping.component').then((m) => m.ScrapingComponent),
  },
  { path: '**', redirectTo: 'data-grid' },
];
