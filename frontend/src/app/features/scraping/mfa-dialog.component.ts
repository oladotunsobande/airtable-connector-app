import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ApiService } from '../../core/api/api.service';

@Component({
  selector: 'app-mfa-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './mfa-dialog.component.html',
  styleUrl: './mfa-dialog.component.scss',
})
export class MfaDialogComponent {
  private readonly dialogRef = inject(MatDialogRef<MfaDialogComponent>);
  private readonly data = inject<{ sessionId: string }>(MAT_DIALOG_DATA);
  private readonly api = inject(ApiService);

  code = '';
  submitting = signal(false);
  error = signal('');

  cancel(): void {
    this.dialogRef.close(false);
  }

  submit(): void {
    if (!this.code.trim()) return;
    this.submitting.set(true);
    this.error.set('');

    this.api.submitMfa(this.data.sessionId, this.code.trim()).subscribe({
      next: () => {
        this.submitting.set(false);
        this.dialogRef.close(true);
      },
      error: (err) => {
        this.submitting.set(false);
        this.error.set(err?.error?.message ?? 'Failed to submit MFA code. Please try again.');
      },
    });
  }
}
