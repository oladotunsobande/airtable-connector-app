export interface RevisionHistoryDocument {
  uuid: string;
  issueId: string;
  columnType: string;
  oldValue: string | null;
  newValue: string | null;
  createdDate: Date;
  authoredBy: string;
}

export interface IRevisionHistoryRepository {
  upsert(revision: RevisionHistoryDocument): Promise<RevisionHistoryDocument>;
  upsertMany(revisions: RevisionHistoryDocument[]): Promise<void>;
  findByIssueId(issueId: string): Promise<RevisionHistoryDocument[]>;
  findAll(options?: { skip?: number; limit?: number }): Promise<RevisionHistoryDocument[]>;
  count(): Promise<number>;
}
