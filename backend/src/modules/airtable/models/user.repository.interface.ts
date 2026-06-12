export interface UserDocument {
  airtableId: string;
  email: string;
  name: string;
  profilePicUrl: string | null;
}

export interface IUserRepository {
  upsert(user: UserDocument): Promise<UserDocument>;
  upsertMany(users: UserDocument[]): Promise<void>;
  findById(airtableId: string): Promise<UserDocument | null>;
  findAll(): Promise<UserDocument[]>;
}
