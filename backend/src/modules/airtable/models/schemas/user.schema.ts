import { Schema, model, type Document } from 'mongoose';
import type { UserDocument } from '../user.repository.interface.js';

export interface UserDoc extends UserDocument, Document {}

export const userSchema = new Schema<UserDoc>(
  {
    airtableId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true },
    name: { type: String, required: true },
    profilePicUrl: { type: String, default: null },
  },
  { timestamps: false },
);

export const UserModel = model<UserDoc>('User', userSchema, 'users');
