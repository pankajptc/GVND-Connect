import { createFileRoute } from "@tanstack/react-router";
import { MeshApp } from "@/components/mesh/MeshApp";

export const Route = createFileRoute("/")({ component: MeshApp });
