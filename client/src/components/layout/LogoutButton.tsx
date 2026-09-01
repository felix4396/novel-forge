import { LogOut } from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";

export default function LogoutButton() {
  const { logout } = useAuth();
  return (
    <Button type="button" variant="ghost" size="icon" onClick={() => void logout()} aria-label="退出登录" title="退出登录">
      <LogOut className="h-4 w-4" />
    </Button>
  );
}
