import { UserService } from './service';

const userService = new UserService();

export function runApp(): string {
  return userService.getDisplayName('alpha');
}
