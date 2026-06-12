import { Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ScrapeRunStore } from '../../core/scrape-run/scrape-run.store';
import { IntegrationsComponent } from '../integrations/integrations.component';
import { ScrapingComponent } from '../scraping/scraping.component';
import { DataGridComponent } from '../data-grid/data-grid.component';

@Component({
  selector: 'app-dashboard',
  imports: [MatIconModule, IntegrationsComponent, ScrapingComponent, DataGridComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  protected readonly store = inject(ScrapeRunStore);
}
